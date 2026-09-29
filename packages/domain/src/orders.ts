import type { Kysely } from 'kysely';
import type { ActorContext } from './access.js';
import type { Database } from './db.js';
import { DomainError } from './errors.js';
import { appendAudit, withUnitOfWork } from './uow.js';

export interface OrderRecord {
  readonly id: string;
  readonly customerId: string;
  readonly status: string;
  readonly currency: string;
  readonly totalMinor: number;
  readonly version: number;
  readonly items: readonly {
    readonly id: string;
    readonly skuId: string;
    readonly quantity: number;
    readonly unitPriceMinor: number;
    readonly titleSnapshot: string;
    readonly attributesSnapshot: unknown;
  }[];
}

export async function getOrder(
  db: Kysely<Database>,
  ctx: ActorContext,
  orderId: string,
): Promise<OrderRecord> {
  const result = await withUnitOfWork(db, ctx, async (trx) => {
    const order = await trx
      .selectFrom('orders')
      .selectAll()
      .where('id', '=', orderId)
      .executeTakeFirst();
    if (!order) {
      await appendAudit(trx, ctx, {
        action: 'orders.read',
        resourceType: 'order',
        resourceId: orderId,
        outcome: 'DENIED',
      });
      return { kind: 'denied' as const };
    }
    const items = await trx
      .selectFrom('order_items')
      .selectAll()
      .where('order_id', '=', orderId)
      .execute();
    await appendAudit(trx, ctx, {
      action: 'orders.read',
      resourceType: 'order',
      resourceId: orderId,
      outcome: 'ALLOWED',
    });
    return {
      kind: 'found' as const,
      order: {
        id: order.id,
        customerId: order.customer_id,
        status: order.status,
        currency: order.currency,
        totalMinor: Number(order.total_minor),
        version: order.version,
        items: items.map((item) => ({
          id: item.id,
          skuId: item.sku_id,
          quantity: item.quantity,
          unitPriceMinor: Number(item.unit_price_minor),
          titleSnapshot: item.title_snapshot,
          attributesSnapshot: item.attributes_snapshot,
        })),
      },
    };
  });
  if (result.kind === 'denied') throw new DomainError('NOT_FOUND', 'Order not found');
  return result.order;
}
