import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { ActorContext } from './access.js';
import { ANOMALY_RULE_VERSION, LEAD_TIME_DAYS, UNUSUAL_ORDER_MIN_OBS } from './constants.js';
import type { Database } from './db.js';
import { appendAudit, withUnitOfWork } from './uow.js';

export interface AnomalyRecord {
  readonly id: string;
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly severity: string;
  readonly status: string;
  readonly skuId: string | null;
  readonly warehouseId: string | null;
  readonly orderId: string | null;
  readonly evidence: unknown;
  readonly windowStart: string;
}

const WINDOW_MS = 5 * 60 * 1000;

export async function detectAnomalies(
  db: Kysely<Database>,
  ctx: ActorContext,
  now = new Date(),
): Promise<readonly AnomalyRecord[]> {
  const windowStart = new Date(Math.floor(now.getTime() / WINDOW_MS) * WINDOW_MS);
  return withUnitOfWork(db, ctx, async (trx) => {
    const balances = await trx.selectFrom('stock_balances').selectAll().execute();
    const created: AnomalyRecord[] = [];

    for (const balance of balances) {
      const available = balance.on_hand - balance.reserved;
      if (available <= balance.safety_stock) {
        const row = await upsertAnomaly(trx, ctx, {
          ruleId: 'critical_stock',
          skuId: balance.sku_id,
          warehouseId: balance.warehouse_id,
          orderId: null,
          severity: available === 0 ? 'critical' : 'warning',
          windowStart,
          evidence: {
            available,
            safety_stock: balance.safety_stock,
            on_hand: balance.on_hand,
            reserved: balance.reserved,
          },
          status: 'OPEN',
        });
        if (row) created.push(row);
      }

      const observation = await trx
        .selectFrom('stock_observations')
        .selectAll()
        .where('sku_id', '=', balance.sku_id)
        .where('warehouse_id', '=', balance.warehouse_id)
        .orderBy('observed_at', 'desc')
        .executeTakeFirst();
      if (observation && observation.counted_quantity !== balance.on_hand) {
        const row = await upsertAnomaly(trx, ctx, {
          ruleId: 'discrepancy',
          skuId: balance.sku_id,
          warehouseId: balance.warehouse_id,
          orderId: null,
          severity: 'warning',
          windowStart,
          evidence: {
            counted: observation.counted_quantity,
            on_hand: balance.on_hand,
            observed_at: observation.observed_at.toISOString(),
          },
          status: 'OPEN',
        });
        if (row) created.push(row);
      }

      const demand = await sql<{ days: number; qty: number }>`
        SELECT COUNT(DISTINCT date_trunc('day', o.created_at))::int AS days,
               COALESCE(SUM(oi.quantity), 0)::int AS qty
        FROM commerce.order_items oi
        JOIN commerce.orders o ON o.tenant_id = oi.tenant_id AND o.id = oi.order_id
        WHERE oi.tenant_id = ${ctx.tenantId}::uuid
          AND oi.sku_id = ${balance.sku_id}::uuid
          AND o.created_at >= ${new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)}
      `.execute(trx);
      const stats = demand.rows[0];
      const days = stats?.days ?? 0;
      const qty = stats?.qty ?? 0;
      if (days === 0 || qty === 0) {
        const row = await upsertAnomaly(trx, ctx, {
          ruleId: 'stockout_risk',
          skuId: balance.sku_id,
          warehouseId: balance.warehouse_id,
          orderId: null,
          severity: 'info',
          windowStart,
          evidence: { reason: 'INSUFFICIENT_DATA', days, qty },
          status: 'INSUFFICIENT_DATA',
        });
        if (row) created.push(row);
      } else {
        const daily = qty / days;
        const cover = available / daily;
        if (cover < LEAD_TIME_DAYS) {
          const row = await upsertAnomaly(trx, ctx, {
            ruleId: 'stockout_risk',
            skuId: balance.sku_id,
            warehouseId: balance.warehouse_id,
            orderId: null,
            severity: 'warning',
            windowStart,
            evidence: {
              available,
              daily_demand: daily,
              cover_days: cover,
              lead_time_days: LEAD_TIME_DAYS,
            },
            status: 'OPEN',
          });
          if (row) created.push(row);
        }
      }
    }

    const orders = await trx.selectFrom('orders').selectAll().execute();
    for (const order of orders) {
      const items = await trx
        .selectFrom('order_items')
        .selectAll()
        .where('order_id', '=', order.id)
        .execute();
      for (const item of items) {
        const history = await trx
          .selectFrom('order_items')
          .select('quantity')
          .where('sku_id', '=', item.sku_id)
          .execute();
        if (history.length < UNUSUAL_ORDER_MIN_OBS) continue;
        const sorted = history.map((h) => h.quantity).sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
        const threshold = Math.max(10, 3 * median);
        if (item.quantity > threshold) {
          const row = await upsertAnomaly(trx, ctx, {
            ruleId: 'unusual_order',
            skuId: item.sku_id,
            warehouseId: null,
            orderId: order.id,
            severity: 'warning',
            windowStart,
            evidence: { quantity: item.quantity, threshold, observations: history.length },
            status: 'OPEN',
          });
          if (row) created.push(row);
        }
      }
    }

    await appendAudit(trx, ctx, {
      action: 'anomalies.detect',
      resourceType: 'anomaly',
      outcome: 'ALLOWED',
    });
    return created;
  });
}

export async function listAnomalies(
  db: Kysely<Database>,
  ctx: ActorContext,
): Promise<readonly AnomalyRecord[]> {
  return withUnitOfWork(db, ctx, async (trx) => {
    const rows = await trx
      .selectFrom('anomalies')
      .selectAll()
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(toRecord);
  });
}

async function upsertAnomaly(
  trx: Parameters<Parameters<typeof withUnitOfWork>[2]>[0],
  ctx: ActorContext,
  input: {
    ruleId: string;
    skuId: string | null;
    warehouseId: string | null;
    orderId: string | null;
    severity: string;
    windowStart: Date;
    evidence: unknown;
    status: string;
  },
): Promise<AnomalyRecord | undefined> {
  const existing = await trx
    .selectFrom('anomalies')
    .selectAll()
    .where('rule_id', '=', input.ruleId)
    .where('window_start', '=', input.windowStart)
    .$if(input.skuId !== null, (qb) => qb.where('sku_id', '=', input.skuId ?? ''))
    .$if(input.skuId === null, (qb) => qb.where('sku_id', 'is', null))
    .$if(input.warehouseId !== null, (qb) => qb.where('warehouse_id', '=', input.warehouseId ?? ''))
    .$if(input.warehouseId === null, (qb) => qb.where('warehouse_id', 'is', null))
    .$if(input.orderId !== null, (qb) => qb.where('order_id', '=', input.orderId ?? ''))
    .$if(input.orderId === null, (qb) => qb.where('order_id', 'is', null))
    .executeTakeFirst();
  if (existing) return undefined;
  const id = randomUUID();
  await trx
    .insertInto('anomalies')
    .values({
      tenant_id: ctx.tenantId,
      id,
      sku_id: input.skuId,
      warehouse_id: input.warehouseId,
      order_id: input.orderId,
      rule_id: input.ruleId,
      rule_version: ANOMALY_RULE_VERSION,
      severity: input.severity,
      evidence: input.evidence,
      window_start: input.windowStart,
      status: input.status,
    })
    .execute();
  return {
    id,
    ruleId: input.ruleId,
    ruleVersion: ANOMALY_RULE_VERSION,
    severity: input.severity,
    status: input.status,
    skuId: input.skuId,
    warehouseId: input.warehouseId,
    orderId: input.orderId,
    evidence: input.evidence,
    windowStart: input.windowStart.toISOString(),
  };
}

function toRecord(row: {
  id: string;
  rule_id: string;
  rule_version: string;
  severity: string;
  status: string;
  sku_id: string | null;
  warehouse_id: string | null;
  order_id: string | null;
  evidence: unknown;
  window_start: Date;
}): AnomalyRecord {
  return {
    id: row.id,
    ruleId: row.rule_id,
    ruleVersion: row.rule_version,
    severity: row.severity,
    status: row.status,
    skuId: row.sku_id,
    warehouseId: row.warehouse_id,
    orderId: row.order_id,
    evidence: row.evidence,
    windowStart: row.window_start.toISOString(),
  };
}
