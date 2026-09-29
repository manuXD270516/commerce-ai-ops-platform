import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { ActorContext } from './access.js';
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
}

const BLOCKED = /password|secret|ssn|credit.?card/i;

export async function createSupportTicket(
  db: Kysely<Database>,
  ctx: ActorContext,
  input: {
    customerId: string;
    orderId?: string;
    category: string;
    summary: string;
    confirmed: boolean;
    idempotencyKey: string;
    evidenceRefs?: unknown;
  },
): Promise<TicketRecord> {
  if (!input.confirmed) {
    throw new DomainError('VALIDATION_ERROR', 'Ticket creation requires explicit confirmation');
  }
  if (BLOCKED.test(input.summary)) {
    throw new DomainError(
      'VALIDATION_ERROR',
      'Ticket content requires human review before persist',
    );
  }
  if (ctx.role === 'customer' && ctx.customerId !== input.customerId) {
    throw new DomainError('FORBIDDEN', 'Cannot open a ticket for another customer');
  }
  return commitIdempotent(
    db,
    ctx,
    'support.create_ticket',
    input.idempotencyKey,
    input,
    async (trx) => {
      const id = randomUUID();
      await trx
        .insertInto('tickets')
        .values({
          tenant_id: ctx.tenantId,
          id,
          customer_id: input.customerId,
          order_id: input.orderId ?? null,
          category: input.category,
          status: 'OPEN',
          summary: input.summary,
          evidence_refs: input.evidenceRefs ?? [],
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
        customerId: input.customerId,
        orderId: input.orderId ?? null,
        category: input.category,
        status: 'OPEN',
        summary: input.summary,
      };
    },
  );
}

export async function listTickets(
  db: Kysely<Database>,
  ctx: ActorContext,
): Promise<readonly TicketRecord[]> {
  return withUnitOfWork(db, ctx, async (trx) => {
    const rows = await trx
      .selectFrom('tickets')
      .selectAll()
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map((row) => ({
      id: row.id,
      customerId: row.customer_id,
      orderId: row.order_id,
      category: row.category,
      status: row.status,
      summary: row.summary,
    }));
  });
}
