import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { ActorContext } from './access.js';
import { CONSENT_TTL_MS } from './constants.js';
import type { Database } from './db.js';
import { DomainError } from './errors.js';
import { payloadHash } from './idempotency.js';
import { appendAudit, withUnitOfWork, type DomainTrx } from './uow.js';

export const CONSENT_COMMANDS = ['create_support_ticket'] as const;
export type ConsentCommand = (typeof CONSENT_COMMANDS)[number];

export interface ConsentRecord {
  readonly id: string;
  readonly command: ConsentCommand;
  readonly payloadHash: string;
  readonly expiresAt: string;
}

/** Canonical ticket payload a consent is bound to; defaults are made explicit before hashing. */
export function ticketConsentPayload(input: {
  orderId?: string;
  category: string;
  summary: string;
  evidenceRefs?: readonly { kind: string; id: string }[];
}): Record<string, unknown> {
  return {
    order_id: input.orderId ?? null,
    category: input.category,
    summary: input.summary,
    evidence_refs: [...(input.evidenceRefs ?? [])]
      .map((r) => ({ kind: r.kind, id: r.id }))
      .sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)),
  };
}

/**
 * Records the subject's explicit consent for one exact payload. Only entry points that
 * authenticate the user's own UI event call this (POST /v1/consents); no tool exposes it, so a
 * model cannot manufacture consent.
 */
export async function recordConsent(
  db: Kysely<Database>,
  ctx: ActorContext,
  input: { command: ConsentCommand; payload: Record<string, unknown>; runId?: string },
): Promise<ConsentRecord> {
  if (!CONSENT_COMMANDS.includes(input.command)) {
    throw new DomainError('VALIDATION_ERROR', 'Unknown consent command', { field: 'command' });
  }
  return withUnitOfWork(db, ctx, async (trx) => {
    const id = randomUUID();
    const hash = payloadHash(input.payload);
    const expiresAt = new Date(Date.now() + CONSENT_TTL_MS);
    await trx
      .insertInto('consents')
      .values({
        tenant_id: ctx.tenantId,
        id,
        subject_id: ctx.subjectId,
        command: input.command,
        payload_hash: hash,
        run_id: input.runId ?? null,
        expires_at: expiresAt,
        consumed_at: null,
      })
      .execute();
    await appendAudit(trx, ctx, {
      action: 'consents.record',
      resourceType: 'consent',
      resourceId: id,
      outcome: 'ALLOWED',
    });
    return { id, command: input.command, payloadHash: hash, expiresAt: expiresAt.toISOString() };
  });
}

/**
 * Consumes a consent inside the caller's transaction: same subject (RLS), same command, same
 * payload hash, not expired and not used. Any mismatch leaves the consent untouched.
 */
export async function consumeConsent(
  trx: DomainTrx,
  ctx: ActorContext,
  input: { consentId: string; command: ConsentCommand; payload: Record<string, unknown> },
): Promise<void> {
  const consent = await trx
    .selectFrom('consents')
    .selectAll()
    .where('id', '=', input.consentId)
    .forUpdate()
    .executeTakeFirst();
  const reason = !consent
    ? 'CONSENT_NOT_FOUND'
    : consent.subject_id !== ctx.subjectId
      ? 'CONSENT_NOT_FOUND'
      : consent.command !== input.command
        ? 'CONSENT_COMMAND_MISMATCH'
        : consent.consumed_at !== null
          ? 'CONSENT_ALREADY_USED'
          : consent.expires_at.getTime() <= Date.now()
            ? 'CONSENT_EXPIRED'
            : consent.payload_hash !== payloadHash(input.payload)
              ? 'CONSENT_PAYLOAD_MISMATCH'
              : undefined;
  if (reason) {
    throw new DomainError('VALIDATION_ERROR', 'WRITE requires a valid explicit consent', {
      reason,
    });
  }
  await trx
    .updateTable('consents')
    .set({ consumed_at: new Date() })
    .where('id', '=', input.consentId)
    .where('consumed_at', 'is', null)
    .executeTakeFirstOrThrow();
}
