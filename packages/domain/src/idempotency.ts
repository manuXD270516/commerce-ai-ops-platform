import { createHash, randomUUID } from 'node:crypto';
import type { ActorContext } from './access.js';
import { sql, type Kysely } from 'kysely';
import type { Database } from './db.js';
import { DomainError } from './errors.js';
import { withUnitOfWork, type DomainTrx } from './uow.js';

export function payloadHash(payload: unknown): string {
  return createHash('sha256').update(stableStringify(payload)).digest('hex');
}

export async function commitIdempotent<T>(
  db: Kysely<Database>,
  ctx: ActorContext,
  command: string,
  idempotencyKey: string,
  payload: unknown,
  fn: (trx: DomainTrx) => Promise<T>,
): Promise<T> {
  const hash = payloadHash(payload);
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)) {
    throw new DomainError('VALIDATION_ERROR', 'Idempotency-Key must have 1-128 safe characters', {
      field: 'idempotency_key',
    });
  }
  return withUnitOfWork(db, ctx, async (trx) => {
    // Serialize requests that share a key, so a concurrent retry waits and then replays the
    // committed result instead of racing the first attempt.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${ctx.tenantId}|${ctx.subjectId}|${command}|${idempotencyKey}`}, 0))`.execute(
      trx,
    );
    const existing = await trx
      .selectFrom('idempotency_records')
      .selectAll()
      .where('tenant_id', '=', ctx.tenantId)
      .where('subject_id', '=', ctx.subjectId)
      .where('command', '=', command)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
    if (existing) {
      if (existing.payload_hash !== hash) {
        throw new DomainError('CONFLICT', 'Idempotency-Key reused with a different payload');
      }
      return existing.response as T;
    }
    const result = await fn(trx);
    await trx
      .insertInto('idempotency_records')
      .values({
        tenant_id: ctx.tenantId,
        id: randomUUID(),
        subject_id: ctx.subjectId,
        command,
        idempotency_key: idempotencyKey,
        payload_hash: hash,
        response: result,
      })
      .execute();
    return result;
  });
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
