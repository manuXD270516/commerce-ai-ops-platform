import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURES,
  applyStockMovement,
  applyTrackingEvent,
  checkInventory,
  createDb,
  createPool,
  detectAnomalies,
  getOrder,
  getShippingStatus,
  migrate,
  orderIsFullyDelivered,
  reserveLastUnits,
  seedCommerceDomain,
  type ActorContext,
} from '../src/index.js';

const adminUrl = process.env.DATABASE_ADMIN_URL;
const migratorUrl = process.env.DATABASE_MIGRATOR_URL;
const runtimeUrl = process.env.DATABASE_URL;
const piiKey = process.env.PII_ENCRYPTION_KEY;
const enabled = Boolean(adminUrl && migratorUrl && runtimeUrl && piiKey);

const acme = FIXTURES.tenants.acme;
const ana: ActorContext = {
  tenantId: acme,
  subjectId: FIXTURES.subjects.ana,
  role: 'customer',
  customerId: FIXTURES.customers.ana,
  policyVersion: 'policy.v1',
};
const support: ActorContext = {
  tenantId: acme,
  subjectId: FIXTURES.subjects.acmeSupport,
  role: 'support',
  policyVersion: 'policy.v1',
};
const inventory: ActorContext = {
  tenantId: acme,
  subjectId: FIXTURES.subjects.acmeInventory,
  role: 'inventory',
  policyVersion: 'policy.v1',
};

const NOW = new Date('2026-09-29T06:00:00.000Z');
const SHIPMENT_A = '00000000-0000-4000-8000-000000000701';
const SHIPMENT_B = '00000000-0000-4000-8000-000000000702';
const WS_BALANCE = '00000000-0000-4000-8000-000000000313';

describe.skipIf(!enabled)('orders, fulfillment and inventory (M3)', () => {
  const pool = createPool(runtimeUrl!);
  const db = createDb(pool);
  const owner = new pg.Client({ connectionString: migratorUrl });

  async function insertOrder(skuId: string, quantity: number, createdAt: string): Promise<string> {
    const orderId = randomUUID();
    const total = quantity * 100;
    await owner.query(
      `INSERT INTO commerce.orders
         (tenant_id, id, customer_id, status, currency, subtotal_minor, tax_minor, shipping_minor, total_minor, created_at)
       VALUES ($1, $2, $3, 'CONFIRMED', 'USD', $4, 0, 0, $4, $5)`,
      [acme, orderId, FIXTURES.customers.ana, total, createdAt],
    );
    await owner.query(
      `INSERT INTO commerce.order_items
         (tenant_id, id, order_id, sku_id, quantity, unit_price_minor, currency, title_snapshot, attributes_snapshot)
       VALUES ($1, $2, $3, $4, $5, 100, 'USD', 'history', '{}'::jsonb)`,
      [acme, randomUUID(), orderId, skuId, quantity],
    );
    return orderId;
  }

  async function count(sqlText: string, params: unknown[]): Promise<number> {
    const res = await owner.query<{ n: number }>(sqlText, params);
    return res.rows[0]?.n ?? -1;
  }

  beforeAll(async () => {
    await migrate({ adminUrl: adminUrl!, migratorUrl: migratorUrl!, runtimeUrl: runtimeUrl! });
    await seedCommerceDomain(migratorUrl!, piiKey!);
    await owner.connect();
  }, 60_000);

  afterAll(async () => {
    await owner.end();
    await db.destroy();
  });

  it('identifies lines and package states of a partial shipment without declaring delivery', async () => {
    const at = new Date('2026-09-28T15:00:00.000Z');
    const order = await getOrder(db, ana, FIXTURES.orders.anaPartial);
    const shipping = await getShippingStatus(db, ana, FIXTURES.orders.anaPartial, at);
    expect(order.items.map((i) => i.titleSnapshot).sort()).toEqual([
      'Mouse',
      'Notebook de desarrollo 16GB',
    ]);
    const byRef = Object.fromEntries(shipping.shipments.map((s) => [s.trackingRef, s]));
    expect(byRef['SIM-401-A']).toMatchObject({ status: 'IN_TRANSIT', stale: false });
    expect(byRef['SIM-401-B']).toMatchObject({ status: 'DELAYED', stale: true });
    expect(byRef['SIM-401-A']?.items).toEqual([
      { orderItemId: '00000000-0000-4000-8000-000000000411', quantity: 1 },
    ]);
    expect(new Set(shipping.shipments.map((s) => s.sourceMode))).toEqual(new Set(['simulated']));
    expect(shipping.orderStatus).toBe('FULFILLING');
    expect(orderIsFullyDelivered(order, shipping)).toBe(false);
  });

  it('applies out-of-order tracking, ignores replays and never regresses to an older state', async () => {
    const event = (id: string, status: string, occurredAt: string, carrier = 'demo-carrier') =>
      applyTrackingEvent(db, support, {
        shipmentId: SHIPMENT_A,
        carrier,
        providerEventId: id,
        status,
        occurredAt: new Date(occurredAt),
      });
    expect(await event('evt-late', 'DELIVERED', '2026-09-29T15:00:00.000Z')).toMatchObject({
      applied: true,
      statusChanged: true,
    });
    expect(await event('evt-early', 'OUT_FOR_DELIVERY', '2026-09-29T10:00:00.000Z')).toMatchObject({
      applied: true,
      statusChanged: false,
    });
    expect(await event('evt-late', 'DELIVERED', '2026-09-29T15:00:00.000Z')).toMatchObject({
      applied: false,
    });
    await expect(
      event('evt-x', 'DELIVERED', '2026-09-29T16:00:00.000Z', 'other'),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(
      await count(
        'SELECT count(*)::int AS n FROM commerce.tracking_events WHERE shipment_id = $1',
        [SHIPMENT_A],
      ),
    ).toBe(2);

    const order = await getOrder(db, ana, FIXTURES.orders.anaPartial);
    const shipping = await getShippingStatus(db, ana, FIXTURES.orders.anaPartial, NOW);
    const statuses = Object.fromEntries(shipping.shipments.map((s) => [s.id, s.status]));
    expect(statuses[SHIPMENT_A]).toBe('DELIVERED');
    expect(statuses[SHIPMENT_B]).toBe('DELAYED');
    expect(orderIsFullyDelivered(order, shipping)).toBe(false);
  });

  it('lets exactly one of two concurrent reservations take the last units', async () => {
    const attempt = () => {
      const eventId = randomUUID();
      return reserveLastUnits(db, support, {
        skuId: FIXTURES.skus.nbWs,
        warehouseId: FIXTURES.warehouses.acmeEast,
        quantity: 2,
        orderId: FIXTURES.orders.benConfirmed,
        orderItemId: '00000000-0000-4000-8000-000000000421',
        eventId,
        idempotencyKey: `res-${eventId}`,
      });
    };
    const results = await Promise.allSettled([attempt(), attempt()]);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: 'CONFLICT' });

    const balance = await owner.query<{ on_hand: number; reserved: number }>(
      'SELECT on_hand, reserved FROM commerce.stock_balances WHERE id = $1',
      [WS_BALANCE],
    );
    expect(balance.rows[0]).toEqual({ on_hand: 2, reserved: 2 });
    expect(
      await count(
        `SELECT count(*)::int AS n FROM commerce.stock_movements WHERE balance_id = $1 AND reason = 'reserve'`,
        [WS_BALANCE],
      ),
    ).toBe(1);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM commerce.reservations WHERE sku_id = $1 AND status = 'ACTIVE'`,
        [FIXTURES.skus.nbWs],
      ),
    ).toBe(1);
  });

  it('replays a retried reservation with the same idempotency key instead of reserving twice', async () => {
    const eventId = randomUUID();
    const input = {
      skuId: FIXTURES.skus.mouse,
      warehouseId: FIXTURES.warehouses.acmeEast,
      quantity: 1,
      orderId: FIXTURES.orders.anaPartial,
      orderItemId: '00000000-0000-4000-8000-000000000412',
      eventId,
      idempotencyKey: `res-${eventId}`,
    };
    const first = await reserveLastUnits(db, support, input);
    const retry = await reserveLastUnits(db, support, input);
    expect(retry.reservationId).toBe(first.reservationId);
    expect(
      await count(
        'SELECT count(*)::int AS n FROM commerce.stock_movements WHERE reference_id = $1',
        [eventId],
      ),
    ).toBe(1);
  });

  it('keeps a single stock effect and movement for a duplicated event_id', async () => {
    const eventId = randomUUID();
    const move = () =>
      applyStockMovement(db, inventory, {
        skuId: FIXTURES.skus.mouse,
        warehouseId: FIXTURES.warehouses.acmeEast,
        deltaOnHand: 5,
        deltaReserved: 0,
        reason: 'receive',
        eventId,
      });
    const before = await checkInventory(db, inventory, FIXTURES.skus.mouse);
    const [a, b] = await Promise.all([move(), move()]);
    expect(a.version).toBe(b.version);
    const after = await checkInventory(db, inventory, FIXTURES.skus.mouse);
    expect(after.detail?.onHand).toBe((before.detail?.onHand ?? 0) + 5);
    expect(
      await count(
        'SELECT count(*)::int AS n FROM commerce.stock_movements WHERE reference_id = $1',
        [eventId],
      ),
    ).toBe(1);
  });

  it('rejects movements that would break on_hand >= reserved >= 0 and leaves no partial write', async () => {
    const eventId = randomUUID();
    await expect(
      applyStockMovement(db, inventory, {
        skuId: FIXTURES.skus.nbWs,
        warehouseId: FIXTURES.warehouses.acmeEast,
        deltaOnHand: -1,
        deltaReserved: 0,
        reason: 'shrink',
        eventId,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(
      await count(
        'SELECT count(*)::int AS n FROM commerce.stock_movements WHERE reference_id = $1',
        [eventId],
      ),
    ).toBe(0);
    expect(
      await count('SELECT count(*)::int AS n FROM commerce.inbox WHERE event_id::text = $1', [
        eventId,
      ]),
    ).toBe(0);
  });

  it('forbids customers from reserving, moving stock or running the detector', async () => {
    await expect(
      applyStockMovement(db, ana, {
        skuId: FIXTURES.skus.mouse,
        warehouseId: FIXTURES.warehouses.acmeEast,
        deltaOnHand: 1,
        deltaReserved: 0,
        reason: 'adjust',
        eventId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(detectAnomalies(db, ana, NOW)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  describe('anomaly detector', () => {
    beforeAll(async () => {
      for (const day of ['2026-09-24', '2026-09-26', '2026-09-28']) {
        await insertOrder(FIXTURES.skus.mouse, 15, `${day}T12:00:00.000Z`);
      }
      await insertOrder(FIXTURES.skus.nb16, 1, '2026-09-27T12:00:00.000Z');
      for (let i = 0; i < 20; i++) {
        await insertOrder(
          FIXTURES.skus.nb16,
          1,
          `2026-08-${String(i + 1).padStart(2, '0')}T12:00:00.000Z`,
        );
      }
    });

    it('records critical stock and a current count discrepancy without adjusting the balance', async () => {
      const before = await checkInventory(db, inventory, FIXTURES.skus.nb32);
      const found = await detectAnomalies(db, inventory, NOW);
      const nb32 = found.filter((a) => a.skuId === FIXTURES.skus.nb32);
      expect(nb32.map((a) => a.ruleId).sort()).toEqual([
        'critical_stock',
        'discrepancy',
        'stockout_risk',
      ]);
      expect(nb32.find((a) => a.ruleId === 'discrepancy')?.evidence).toMatchObject({
        counted: 1,
        on_hand: 4,
      });
      const after = await checkInventory(db, inventory, FIXTURES.skus.nb32);
      expect(after.detail).toEqual(before.detail);
    });

    it('does not duplicate alerts when the job repeats or runs concurrently in the same window', async () => {
      const again = await detectAnomalies(db, inventory, NOW);
      expect(again).toHaveLength(0);
      const later = new Date(NOW.getTime() + 60_000);
      const [x, y] = await Promise.all([
        detectAnomalies(db, inventory, later),
        detectAnomalies(db, inventory, later),
      ]);
      expect(x.length + y.length).toBe(0);
      expect(
        await count(
          `SELECT count(*)::int AS n FROM (
             SELECT 1 FROM commerce.anomalies
             GROUP BY tenant_id, rule_id, sku_id, warehouse_id, order_id, window_start
             HAVING count(*) > 1) d`,
          [],
        ),
      ).toBe(0);
    });

    it('reports INSUFFICIENT_DATA for zero demand and too few demand days, never a prediction', async () => {
      const window = new Date('2026-09-29T07:00:00.000Z');
      const found = await detectAnomalies(db, inventory, window);
      const risk = (skuId: string) =>
        found.find((a) => a.ruleId === 'stockout_risk' && a.skuId === skuId);
      expect(risk(FIXTURES.skus.nb32AtBudget)).toMatchObject({
        status: 'INSUFFICIENT_DATA',
        evidence: { reason: 'zero_demand', demand_qty: 0 },
      });
      expect(risk(FIXTURES.skus.nb16)).toMatchObject({
        status: 'INSUFFICIENT_DATA',
        evidence: { reason: 'few_demand_days', demand_days: 1 },
      });
      expect(JSON.stringify(found)).not.toMatch(/Infinity|NaN/);
    });

    it('computes stockout risk from 7-day average demand when history is sufficient', async () => {
      const found = await detectAnomalies(db, inventory, new Date('2026-09-29T07:10:00.000Z'));
      const mouse = found.find(
        (a) => a.ruleId === 'stockout_risk' && a.skuId === FIXTURES.skus.mouse,
      );
      expect(mouse?.status).toBe('OPEN');
      expect(mouse?.evidence).toMatchObject({ daily_demand: 6.429, lead_time_days: 7 });
    });

    it('flags an unusual order only with >= 20 observations and quantity > max(10, 3 x median)', async () => {
      const old = await insertOrder(FIXTURES.skus.nb16, 40, '2026-08-25T12:00:00.000Z');
      const atThreshold = await insertOrder(FIXTURES.skus.nb16, 10, '2026-09-29T07:12:00.000Z');
      const big = await insertOrder(FIXTURES.skus.nb16, 11, '2026-09-29T07:14:00.000Z');
      const found = await detectAnomalies(db, inventory, new Date('2026-09-29T07:20:00.000Z'));
      const unusual = found.filter((a) => a.ruleId === 'unusual_order');
      expect(unusual.map((a) => a.orderId)).toEqual([big]);
      expect(unusual.map((a) => a.orderId)).not.toContain(old);
      expect(unusual.map((a) => a.orderId)).not.toContain(atThreshold);
      expect(unusual[0]).toMatchObject({
        windowStart: '2026-09-29T07:10:00.000Z',
        evidence: { quantity: 11, threshold: 10, median: 1 },
      });
      const later = await detectAnomalies(db, inventory, new Date('2026-09-29T09:00:00.000Z'));
      expect(later.filter((a) => a.ruleId === 'unusual_order')).toHaveLength(0);
    });

    it('ignores stock counts older than 72 hours', async () => {
      const found = await detectAnomalies(db, inventory, new Date('2026-10-03T00:00:00.000Z'));
      expect(found.some((a) => a.ruleId === 'discrepancy')).toBe(false);
    });
  });
});
