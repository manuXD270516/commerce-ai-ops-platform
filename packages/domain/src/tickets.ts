import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { ActorContext } from './access.js';
import { assertRole } from './actors.js';
import { consumeConsent, ticketConsentPayload } from './consents.js';
import { TICKETS_PER_SUBJECT_PER_HOUR } from './constants.js';
import type { Database } from './db.js';
import { DomainError } from './errors.js';
import { commitIdempotent } from './idempotency.js';
import { appendAudit, appendOutbox, withUnitOfWork } from './uow.js';

export interface TicketRecord {
  readonly id: string;
  readonly customerId: string;
  readonly orderId: string | null;
  readonly category: string;
  readonly status: string;
  readonly summary: string;
  readonly createdAt?: string;
}

export const TICKET_CATEGORIES = [
  'delivery_delay',
  'lost_package',
  'damaged_item',
  'cancellation',
  'other',
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export interface EvidenceRef {
  readonly kind: 'order' | 'shipment' | 'document_version' | 'anomaly';
  readonly id: string;
}

export interface CreateTicketInput {
  readonly orderId?: string;
  readonly category: TicketCategory;
  readonly summary: string;
  readonly evidenceRefs?: readonly EvidenceRef[];
  /** Id returned by recordConsent for this exact payload; model text is never consent. */
  readonly consentId: string;
  readonly idempotencyKey: string;
}

/**
 * Content a model or user could paste into a ticket but that support does not need. It is not
 * persisted: the request is refused with REQUIRES_HUMAN_REVIEW so a person can redact it first.
 */
const SENSITIVE: readonly { readonly kind: string; readonly pattern: RegExp }[] = [
  { kind: 'credential', pattern: /\b(password|contrase(ñ|n)a|secret|api[ _-]?key|token)\b/i },
  { kind: 'government_id', pattern: /\b(ssn|dni|pasaporte|passport)\b/i },
  { kind: 'card_number', pattern: /\b(?:\d[ -]?){13,19}\b/ },
  { kind: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { kind: 'phone', pattern: /\+?\d[\d ()-]{8,}\d/ },
];

export function sensitiveContentKinds(text: string): string[] {
  return SENSITIVE.filter((s) => s.pattern.test(text)).map((s) => s.kind);
}

export async function createSupportTicket(
  db: Kysely<Database>,
  ctx: ActorContext,
  input: CreateTicketInput,
): Promise<TicketRecord> {
  assertRole(ctx, ['customer', 'support']);
  if (!TICKET_CATEGORIES.includes(input.category)) {
    throw new DomainError('VALIDATION_ERROR', 'Unknown ticket category', { field: 'category' });
  }
  const summary = input.summary.trim();
  if (summary.length < 10 || summary.length > 500) {
    throw new DomainError('VALIDATION_ERROR', 'summary must have 10-500 characters', {
      field: 'summary',
    });
  }
  const sensitive = sensitiveContentKinds(summary);
  if (sensitive.length > 0) {
    await withUnitOfWork(db, ctx, (trx) =>
      appendAudit(trx, ctx, {
        action: 'tickets.create',
        resourceType: 'ticket',
        outcome: 'DENIED',
      }),
    );
    throw new DomainError('VALIDATION_ERROR', 'Ticket content requires human review', {
      reason: 'REQUIRES_HUMAN_REVIEW',
      kinds: sensitive,
    });
  }
  const consentPayload = ticketConsentPayload({ ...input, summary });
  return commitIdempotent(
    db,
    ctx,
    'support.create_ticket',
    input.idempotencyKey,
    consentPayload,
    async (trx) => {
      await consumeConsent(trx, ctx, {
        consentId: input.consentId,
        command: 'create_support_ticket',
        payload: consentPayload,
      });
      const recent = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM commerce.tickets
        WHERE created_by = ${ctx.subjectId} AND created_at > now() - interval '1 hour'
      `.execute(trx);
      if ((recent.rows[0]?.n ?? 0) >= TICKETS_PER_SUBJECT_PER_HOUR) {
        throw new DomainError('BUDGET_EXCEEDED', 'Ticket rate limit reached', {
          limit: 'tickets_per_subject_per_hour',
        });
      }
      let customerId: string;
      if (input.orderId) {
        const order = await trx
          .selectFrom('orders')
          .select(['id', 'customer_id'])
          .where('id', '=', input.orderId)
          .executeTakeFirst();
        if (!order) throw new DomainError('NOT_FOUND', 'Order not found');
        customerId = order.customer_id;
      } else if (ctx.role === 'customer' && ctx.customerId) {
        customerId = ctx.customerId;
      } else {
        throw new DomainError('VALIDATION_ERROR', 'order_id is required for support tickets', {
          field: 'order_id',
        });
      }
      const id = randomUUID();
      await trx
        .insertInto('tickets')
        .values({
          tenant_id: ctx.tenantId,
          id,
          customer_id: customerId,
          order_id: input.orderId ?? null,
          category: input.category,
          status: 'OPEN',
          summary,
          evidence_refs: JSON.stringify(consentPayload.evidence_refs),
          created_by: ctx.subjectId,
        })
        .execute();
      await appendOutbox(trx, ctx, {
        aggregateType: 'ticket',
        aggregateId: id,
        aggregateVersion: 1,
        payload: { type: 'TicketOpened', ticketId: id },
      });
      await appendAudit(trx, ctx, {
        action: 'tickets.create',
        resourceType: 'ticket',
        resourceId: id,
        outcome: 'ALLOWED',
      });
      return {
        id,
        customerId,
        orderId: input.orderId ?? null,
        category: input.category,
        status: 'OPEN',
        summary,
      };
    },
  );
}

export async function listTickets(
  db: Kysely<Database>,
  ctx: ActorContext,
): Promise<readonly TicketRecord[]> {
  assertRole(ctx, ['customer', 'support', 'approver', 'admin']);
  return withUnitOfWork(db, ctx, async (trx) => {
    const rows = await trx
      .selectFrom('tickets')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(50)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      customerId: row.customer_id,
      orderId: row.order_id,
      category: row.category,
      status: row.status,
      summary: row.summary,
      createdAt: row.created_at.toISOString(),
    }));
  });
}
