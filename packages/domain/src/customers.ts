import type { Kysely } from 'kysely';
import type { ActorContext } from './access.js';
import type { Database } from './db.js';
import { DomainError } from './errors.js';
import { appendAudit, withUnitOfWork } from './uow.js';

export interface CustomerRecord {
  readonly id: string;
  readonly displayName: string;
  readonly observedAt: string;
}

export async function getCustomer(
  db: Kysely<Database>,
  ctx: ActorContext,
  customerId: string,
): Promise<CustomerRecord> {
  const result = await withUnitOfWork(db, ctx, async (trx) => {
    const row = await trx
      .selectFrom('customers')
      .select(['id', 'display_name'])
      .where('id', '=', customerId)
      .executeTakeFirst();
    if (!row) {
      await appendAudit(trx, ctx, {
        action: 'customers.read',
        resourceType: 'customer',
        resourceId: customerId,
        outcome: 'DENIED',
      });
      return { kind: 'denied' as const };
    }
    await appendAudit(trx, ctx, {
      action: 'customers.read',
      resourceType: 'customer',
      resourceId: customerId,
      outcome: 'ALLOWED',
    });
    return { kind: 'found' as const, row };
  });
  if (result.kind === 'denied') throw new DomainError('NOT_FOUND', 'Customer not found');
  return {
    id: result.row.id,
    displayName: result.row.display_name,
    observedAt: new Date().toISOString(),
  };
}
