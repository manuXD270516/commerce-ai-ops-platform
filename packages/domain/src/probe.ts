import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { ActorContext } from './access.js';
import type { Database } from './db.js';
import { commitIdempotent } from './idempotency.js';
import { appendAudit, appendOutbox } from './uow.js';

/** Domain-level probe used to verify idempotency, outbox and rollback. Not a business command. */
export function recordProbe(
  db: Kysely<Database>,
  ctx: ActorContext,
  idempotencyKey: string,
  payload: { readonly marker: string },
): Promise<{ eventId: string; marker: string }> {
  return commitIdempotent(db, ctx, 'system.probe', idempotencyKey, payload, async (trx) => {
    const eventId = await appendOutbox(trx, ctx, {
      eventId: randomUUID(),
      aggregateType: 'probe',
      aggregateId: ctx.tenantId,
      aggregateVersion: 1,
      payload,
    });
    await appendAudit(trx, ctx, {
      action: 'system.probe',
      resourceType: 'probe',
      resourceId: eventId,
      outcome: 'ALLOWED',
    });
    return { eventId, marker: payload.marker };
  });
}
