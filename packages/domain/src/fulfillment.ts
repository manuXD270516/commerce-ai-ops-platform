import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { ActorContext } from './access.js';
import { assertRole } from './actors.js';
import { STALE_TRACKING_MS } from './constants.js';
import type { Database } from './db.js';
import { DomainError } from './errors.js';
import { claimInbox } from './inventory.js';
import { appendAudit, withUnitOfWork } from './uow.js';
import { getOrder, type OrderRecord } from './orders.js';

export const TRACKING_STATUSES = [
  'LABELLED',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'LOST',
  'DELIVERED_DISPUTED',
  'DELAYED',
] as const;

export interface ShipmentView {
  readonly id: string;
  readonly fulfillmentId: string;
  readonly status: string;
  readonly trackingRef: string;
  readonly carrier: string;
  readonly lastObservedAt: string;
  readonly stale: boolean;
  readonly sourceMode: 'simulated';
  readonly items: readonly { readonly orderItemId: string; readonly quantity: number }[];
}

export interface ShippingStatus {
  readonly orderId: string;
  readonly orderStatus: string;
  readonly shipments: readonly ShipmentView[];
  readonly observedAt: string;
}

export async function getShippingStatus(
  db: Kysely<Database>,
  ctx: ActorContext,
  orderId: string,
  now = new Date(),
): Promise<ShippingStatus> {
  const order = await getOrder(db, ctx, orderId);
  return withUnitOfWork(db, ctx, async (trx) => {
    const fulfillments = await trx
      .selectFrom('fulfillments')
      .selectAll()
      .where('order_id', '=', orderId)
      .execute();
    const shipments: ShipmentView[] = [];
    for (const fulfillment of fulfillments) {
      const items = await trx
        .selectFrom('fulfillment_items')
        .select(['order_item_id', 'quantity'])
        .where('fulfillment_id', '=', fulfillment.id)
        .execute();
      const rows = await trx
        .selectFrom('shipments')
        .selectAll()
        .where('fulfillment_id', '=', fulfillment.id)
        .execute();
      for (const row of rows) {
        const age = now.getTime() - row.last_observed_at.getTime();
        shipments.push({
          id: row.id,
          fulfillmentId: fulfillment.id,
          status: row.status,
          trackingRef: row.tracking_ref,
          carrier: row.carrier,
          lastObservedAt: row.last_observed_at.toISOString(),
          stale: age > STALE_TRACKING_MS,
          sourceMode: 'simulated',
          items: items.map((item) => ({
            orderItemId: item.order_item_id,
            quantity: item.quantity,
          })),
        });
      }
    }
    await appendAudit(trx, ctx, {
      action: 'shipping.read',
      resourceType: 'order',
      resourceId: orderId,
      outcome: 'ALLOWED',
    });
    return {
      orderId,
      orderStatus: order.status,
      shipments,
      observedAt: now.toISOString(),
    };
  });
}

export async function applyTrackingEvent(
  db: Kysely<Database>,
  ctx: ActorContext,
  input: {
    shipmentId: string;
    carrier: string;
    providerEventId: string;
    status: string;
    occurredAt: Date;
  },
): Promise<{ applied: boolean; statusChanged?: boolean }> {
  assertRole(ctx, ['support', 'inventory', 'admin']);
  if (!(TRACKING_STATUSES as readonly string[]).includes(input.status)) {
    throw new DomainError('VALIDATION_ERROR', 'Unknown tracking status');
  }
  return withUnitOfWork(db, ctx, async (trx) => {
    const shipment = await trx
      .selectFrom('shipments')
      .selectAll()
      .where('id', '=', input.shipmentId)
      .forUpdate()
      .executeTakeFirst();
    if (!shipment) throw new DomainError('NOT_FOUND', 'Shipment not found');
    if (shipment.carrier !== input.carrier) {
      throw new DomainError('VALIDATION_ERROR', 'Event carrier does not match the shipment');
    }
    const claimed = await claimInbox(
      trx,
      ctx,
      'shipping.tracking',
      `${input.carrier}:${input.providerEventId}`,
    );
    if (!claimed) return { applied: false };
    await trx
      .insertInto('tracking_events')
      .values({
        tenant_id: ctx.tenantId,
        id: randomUUID(),
        shipment_id: input.shipmentId,
        carrier: input.carrier,
        provider_event_id: input.providerEventId,
        status: input.status,
        occurred_at: input.occurredAt,
      })
      .execute();
    const newer = input.occurredAt.getTime() > shipment.last_observed_at.getTime();
    if (newer) {
      await trx
        .updateTable('shipments')
        .set({ status: input.status, last_observed_at: input.occurredAt })
        .where('id', '=', input.shipmentId)
        .execute();
    }
    await appendAudit(trx, ctx, {
      action: 'shipping.tracking_event',
      resourceType: 'shipment',
      resourceId: input.shipmentId,
      outcome: 'ALLOWED',
    });
    return { applied: true, statusChanged: newer };
  });
}

export function orderIsFullyDelivered(order: OrderRecord, shipping: ShippingStatus): boolean {
  if (shipping.shipments.length === 0) return false;
  const shippedQty = shipping.shipments.reduce(
    (sum, shipment) => sum + shipment.items.reduce((n, item) => n + item.quantity, 0),
    0,
  );
  const orderedQty = order.items.reduce((n, item) => n + item.quantity, 0);
  return shippedQty >= orderedQty && shipping.shipments.every((s) => s.status === 'DELIVERED');
}
