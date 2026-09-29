import { createHash, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { ActorContext } from './access.js';
import { assertRole } from './actors.js';
import type { Database } from './db.js';
import { DomainError } from './errors.js';
import { commitIdempotent } from './idempotency.js';
import { appendAudit, appendOutbox, withUnitOfWork, type DomainTrx } from './uow.js';

export interface ReservationResult {
  readonly reservationId: string;
  readonly available: number;
  readonly version: number;
}

export async function reserveLastUnits(
  db: Kysely<Database>,
  ctx: ActorContext,
  input: {
    skuId: string;
    warehouseId: string;
    quantity: number;
    orderId: string;
    orderItemId: string;
    eventId: string;
    idempotencyKey: string;
  },
): Promise<ReservationResult> {
  assertRole(ctx, ['inventory', 'support', 'admin']);
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) {
    throw new DomainError('VALIDATION_ERROR', 'quantity must be a positive integer');
  }
  return commitIdempotent(
    db,
    ctx,
    'inventory.reserve',
    input.idempotencyKey,
    input,
    async (trx) => {
      const claimed = await claimInbox(trx, ctx, 'inventory.reserve', input.eventId);
      if (!claimed) {
        const existing = await trx
          .selectFrom('reservations')
          .selectAll()
          .where('order_item_id', '=', input.orderItemId)
          .where('status', '=', 'ACTIVE')
          .executeTakeFirst();
        if (!existing) throw new DomainError('CONFLICT', 'Duplicate event without reservation');
        const balance = await trx
          .selectFrom('stock_balances')
          .selectAll()
          .where('sku_id', '=', input.skuId)
          .where('warehouse_id', '=', input.warehouseId)
          .executeTakeFirstOrThrow();
        return {
          reservationId: existing.id,
          available: balance.on_hand - balance.reserved,
          version: balance.version,
        };
      }
      const balance = await trx
        .selectFrom('stock_balances')
        .selectAll()
        .where('sku_id', '=', input.skuId)
        .where('warehouse_id', '=', input.warehouseId)
        .forUpdate()
        .executeTakeFirst();
      if (!balance) throw new DomainError('NOT_FOUND', 'Stock balance not found');
      const available = balance.on_hand - balance.reserved;
      if (available < input.quantity) {
        throw new DomainError('CONFLICT', 'Insufficient available quantity', { available });
      }
      const reservationId = randomUUID();
      await trx
        .insertInto('reservations')
        .values({
          tenant_id: ctx.tenantId,
          id: reservationId,
          order_id: input.orderId,
          order_item_id: input.orderItemId,
          sku_id: input.skuId,
          warehouse_id: input.warehouseId,
          quantity: input.quantity,
          status: 'ACTIVE',
          expires_at: new Date(Date.now() + 30 * 60 * 1000),
        })
        .execute();
      await trx
        .updateTable('stock_balances')
        .set({ reserved: balance.reserved + input.quantity, version: balance.version + 1 })
        .where('id', '=', balance.id)
        .where('version', '=', balance.version)
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('stock_movements')
        .values({
          tenant_id: ctx.tenantId,
          id: randomUUID(),
          balance_id: balance.id,
          delta_on_hand: 0,
          delta_reserved: input.quantity,
          reason: 'reserve',
          reference_id: input.eventId,
        })
        .execute();
      await appendOutbox(trx, ctx, {
        eventId: toEventUuid(input.eventId),
        aggregateType: 'stock_balance',
        aggregateId: balance.id,
        aggregateVersion: balance.version + 1,
        payload: { type: 'InventoryChanged', skuId: input.skuId, deltaReserved: input.quantity },
      });
      await appendAudit(trx, ctx, {
        action: 'inventory.reserve',
        resourceType: 'stock_balance',
        resourceId: balance.id,
        outcome: 'ALLOWED',
      });
      return {
        reservationId,
        available: available - input.quantity,
        version: balance.version + 1,
      };
    },
  );
}

export async function applyStockMovement(
  db: Kysely<Database>,
  ctx: ActorContext,
  input: {
    skuId: string;
    warehouseId: string;
    deltaOnHand: number;
    deltaReserved: number;
    reason: string;
    eventId: string;
  },
): Promise<{ version: number }> {
  assertRole(ctx, ['inventory', 'admin']);
  if (!Number.isSafeInteger(input.deltaOnHand) || !Number.isSafeInteger(input.deltaReserved)) {
    throw new DomainError('VALIDATION_ERROR', 'deltas must be integers');
  }
  return withUnitOfWork(db, ctx, async (trx) => {
    const claimed = await claimInbox(trx, ctx, 'inventory.movement', input.eventId);
    if (!claimed) {
      const balance = await trx
        .selectFrom('stock_balances')
        .selectAll()
        .where('sku_id', '=', input.skuId)
        .where('warehouse_id', '=', input.warehouseId)
        .executeTakeFirstOrThrow();
      return { version: balance.version };
    }
    const balance = await trx
      .selectFrom('stock_balances')
      .selectAll()
      .where('sku_id', '=', input.skuId)
      .where('warehouse_id', '=', input.warehouseId)
      .forUpdate()
      .executeTakeFirst();
    if (!balance) throw new DomainError('NOT_FOUND', 'Stock balance not found');
    const onHand = balance.on_hand + input.deltaOnHand;
    const reserved = balance.reserved + input.deltaReserved;
    if (onHand < 0 || reserved < 0 || onHand < reserved) {
      throw new DomainError('CONFLICT', 'Movement would violate on_hand >= reserved >= 0');
    }
    await trx
      .updateTable('stock_balances')
      .set({ on_hand: onHand, reserved, version: balance.version + 1 })
      .where('id', '=', balance.id)
      .where('version', '=', balance.version)
      .executeTakeFirstOrThrow();
    await trx
      .insertInto('stock_movements')
      .values({
        tenant_id: ctx.tenantId,
        id: randomUUID(),
        balance_id: balance.id,
        delta_on_hand: input.deltaOnHand,
        delta_reserved: input.deltaReserved,
        reason: input.reason,
        reference_id: input.eventId,
      })
      .execute();
    await appendOutbox(trx, ctx, {
      eventId: toEventUuid(input.eventId),
      aggregateType: 'stock_balance',
      aggregateId: balance.id,
      aggregateVersion: balance.version + 1,
      payload: {
        type: 'InventoryChanged',
        skuId: input.skuId,
        deltaOnHand: input.deltaOnHand,
        deltaReserved: input.deltaReserved,
      },
    });
    await appendAudit(trx, ctx, {
      action: 'inventory.movement',
      resourceType: 'stock_balance',
      resourceId: balance.id,
      outcome: 'ALLOWED',
    });
    return { version: balance.version + 1 };
  });
}

export async function claimInbox(
  trx: DomainTrx,
  ctx: ActorContext,
  consumer: string,
  eventId: string,
): Promise<boolean> {
  const eventUuid = toEventUuid(eventId);
  const inserted = await sql<{ ok: number }>`
    INSERT INTO commerce.inbox (tenant_id, id, consumer, event_id)
    VALUES (${ctx.tenantId}::uuid, ${randomUUID()}::uuid, ${consumer}, ${eventUuid}::uuid)
    ON CONFLICT (tenant_id, consumer, event_id) DO NOTHING
    RETURNING 1 AS ok
  `.execute(trx);
  return (inserted.rows[0]?.ok ?? 0) === 1;
}

export function toEventUuid(eventId: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(eventId))
    return eventId;
  const hex = createHash('sha256').update(eventId).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
