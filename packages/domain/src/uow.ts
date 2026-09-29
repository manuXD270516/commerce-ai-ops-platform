import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { ActorContext } from './access.js';
import { assertCustomerScope } from './access.js';
import type { Database } from './db.js';

export type DomainTrx = Transaction<Database>;

export async function withUnitOfWork<T>(
  db: Kysely<Database>,
  ctx: ActorContext,
  fn: (trx: DomainTrx) => Promise<T>,
): Promise<T> {
  assertCustomerScope(ctx);
  return db.transaction().execute(async (trx) => {
    await applySession(trx, ctx);
    return fn(trx);
  });
}

export async function applySession(trx: DomainTrx, ctx: ActorContext): Promise<void> {
  await sql`SELECT set_config('app.tenant_id', ${ctx.tenantId}, true)`.execute(trx);
  await sql`SELECT set_config('app.subject_id', ${ctx.subjectId}, true)`.execute(trx);
  await sql`SELECT set_config('app.role', ${ctx.role}, true)`.execute(trx);
  await sql`SELECT set_config('app.customer_id', ${ctx.customerId ?? ''}, true)`.execute(trx);
}

export async function appendAudit(
  trx: DomainTrx,
  ctx: ActorContext,
  entry: {
    action: string;
    resourceType: string;
    resourceId?: string;
    outcome: 'ALLOWED' | 'DENIED' | 'ERROR';
  },
): Promise<void> {
  await trx
    .insertInto('audit_events')
    .values({
      tenant_id: ctx.tenantId,
      id: randomUUID(),
      actor_subject_id: ctx.subjectId,
      action: entry.action,
      resource_type: entry.resourceType,
      resource_id: entry.resourceId ?? null,
      outcome: entry.outcome,
      policy_version: ctx.policyVersion,
      correlation_id: ctx.correlationId ?? null,
    })
    .execute();
}

export async function appendOutbox(
  trx: DomainTrx,
  ctx: ActorContext,
  event: {
    eventId?: string;
    aggregateType: string;
    aggregateId: string;
    aggregateVersion: number;
    payload: unknown;
  },
): Promise<string> {
  const eventId = event.eventId ?? randomUUID();
  await trx
    .insertInto('outbox')
    .values({
      tenant_id: ctx.tenantId,
      id: randomUUID(),
      event_id: eventId,
      aggregate_type: event.aggregateType,
      aggregate_id: event.aggregateId,
      aggregate_version: event.aggregateVersion,
      payload: event.payload,
      status: 'pending',
    })
    .execute();
  return eventId;
}
