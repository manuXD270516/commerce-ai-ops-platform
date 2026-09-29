import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { ActorContext } from './access.js';
import { assertRole } from './actors.js';
import {
  ANOMALY_RULE_VERSION,
  ANOMALY_WINDOW_MS,
  DEMAND_WINDOW_DAYS,
  LEAD_TIME_DAYS,
  MIN_DEMAND_DAYS,
  POLICY_VERSION,
  STOCK_COUNT_MAX_AGE_MS,
  UNUSUAL_ORDER_MIN_OBS,
} from './constants.js';
import type { Database } from './db.js';
import { appendAudit, withUnitOfWork, type DomainTrx } from './uow.js';

export type AnomalyRule = 'critical_stock' | 'discrepancy' | 'unusual_order' | 'stockout_risk';

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

interface Finding {
  readonly ruleId: AnomalyRule;
  readonly skuId: string | null;
  readonly warehouseId: string | null;
  readonly orderId: string | null;
  readonly severity: 'info' | 'warning' | 'critical';
  readonly status: 'OPEN' | 'INSUFFICIENT_DATA';
  readonly evidence: Record<string, unknown>;
  readonly windowStart?: Date;
}

export const ANOMALY_DETECTOR_SUBJECT = 'service:anomaly-detector';

/**
 * Explicit service identity for the scheduled detector. It carries the inventory role, so it can
 * read stock and record alerts but has no order, ticket or approval commands, and it never
 * inherits a human membership.
 */
export function anomalyDetectorActor(tenantId: string, correlationId?: string): ActorContext {
  return {
    tenantId,
    subjectId: ANOMALY_DETECTOR_SUBJECT,
    role: 'inventory',
    correlationId,
    policyVersion: POLICY_VERSION,
  };
}

export async function listTenantIds(db: Kysely<Database>): Promise<readonly string[]> {
  const rows = await db.selectFrom('tenants').select('id').orderBy('id').execute();
  return rows.map((r) => r.id);
}

/**
 * Runs the four versioned rules of docs/agents-security-mcp.md. Findings are only recorded as
 * alerts: nothing here touches stock balances or opens tickets. Returns alerts newly created in
 * this window; a repeated run in the same window returns none for the same resource and rule.
 */
export async function detectAnomalies(
  db: Kysely<Database>,
  ctx: ActorContext,
  now = new Date(),
): Promise<readonly AnomalyRecord[]> {
  assertRole(ctx, ['inventory', 'admin']);
  const windowStart = windowOf(now);
  return withUnitOfWork(db, ctx, async (trx) => {
    const findings = [
      ...(await stockFindings(trx, now)),
      ...(await unusualOrderFindings(trx, now)),
    ];
    const created: AnomalyRecord[] = [];
    for (const finding of findings) {
      const row = await insertOnce(trx, ctx, finding, windowStart);
      if (row) created.push(row);
    }
    await appendAudit(trx, ctx, {
      action: 'anomalies.detect',
      resourceType: 'anomaly',
      outcome: 'ALLOWED',
    });
    return created;
  });
}

async function stockFindings(trx: DomainTrx, now: Date): Promise<Finding[]> {
  const since = new Date(now.getTime() - DEMAND_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const countCutoff = new Date(now.getTime() - STOCK_COUNT_MAX_AGE_MS);
  const rows = await sql<{
    sku_id: string;
    warehouse_id: string;
    on_hand: number;
    reserved: number;
    safety_stock: number;
    counted: number | null;
    counted_at: Date | null;
    demand_days: number;
    demand_qty: number;
  }>`
    SELECT b.sku_id, b.warehouse_id, b.on_hand, b.reserved, b.safety_stock,
           obs.counted_quantity AS counted, obs.observed_at AS counted_at,
           COALESCE(d.days, 0)::int AS demand_days, COALESCE(d.qty, 0)::int AS demand_qty
    FROM commerce.stock_balances b
    LEFT JOIN LATERAL (
      SELECT o.counted_quantity, o.observed_at
      FROM commerce.stock_observations o
      WHERE o.tenant_id = b.tenant_id AND o.sku_id = b.sku_id AND o.warehouse_id = b.warehouse_id
        AND o.observed_at >= ${countCutoff} AND o.observed_at <= ${now}
      ORDER BY o.observed_at DESC
      LIMIT 1
    ) obs ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(DISTINCT date_trunc('day', ord.created_at)) AS days, SUM(oi.quantity) AS qty
      FROM commerce.order_items oi
      JOIN commerce.orders ord ON ord.tenant_id = oi.tenant_id AND ord.id = oi.order_id
      WHERE oi.tenant_id = b.tenant_id AND oi.sku_id = b.sku_id
        AND ord.status <> 'CANCELLED'
        AND ord.created_at >= ${since} AND ord.created_at <= ${now}
    ) d ON true
    ORDER BY b.sku_id, b.warehouse_id
  `.execute(trx);

  const findings: Finding[] = [];
  for (const b of rows.rows) {
    const available = b.on_hand - b.reserved;
    const key = { skuId: b.sku_id, warehouseId: b.warehouse_id, orderId: null };
    if (available <= b.safety_stock) {
      findings.push({
        ...key,
        ruleId: 'critical_stock',
        severity: available === 0 ? 'critical' : 'warning',
        status: 'OPEN',
        evidence: {
          available,
          safety_stock: b.safety_stock,
          on_hand: b.on_hand,
          reserved: b.reserved,
        },
      });
    }
    if (b.counted !== null && b.counted_at !== null && b.counted !== b.on_hand) {
      findings.push({
        ...key,
        ruleId: 'discrepancy',
        severity: 'warning',
        status: 'OPEN',
        evidence: {
          counted: b.counted,
          on_hand: b.on_hand,
          counted_at: b.counted_at.toISOString(),
        },
      });
    }
    if (b.demand_qty === 0 || b.demand_days < MIN_DEMAND_DAYS) {
      findings.push({
        ...key,
        ruleId: 'stockout_risk',
        severity: 'info',
        status: 'INSUFFICIENT_DATA',
        evidence: {
          reason: b.demand_qty === 0 ? 'zero_demand' : 'few_demand_days',
          demand_days: b.demand_days,
          demand_qty: b.demand_qty,
          min_demand_days: MIN_DEMAND_DAYS,
        },
      });
      continue;
    }
    const dailyDemand = b.demand_qty / DEMAND_WINDOW_DAYS;
    const coverDays = available / dailyDemand;
    if (coverDays < LEAD_TIME_DAYS) {
      findings.push({
        ...key,
        ruleId: 'stockout_risk',
        severity: 'warning',
        status: 'OPEN',
        evidence: {
          available,
          daily_demand: Number(dailyDemand.toFixed(3)),
          cover_days: Number(coverDays.toFixed(2)),
          lead_time_days: LEAD_TIME_DAYS,
        },
      });
    }
  }
  return findings;
}

/**
 * Orders from the last DEMAND_WINDOW_DAYS are compared with the non-cancelled history of the same
 * SKU strictly before them. The alert window is the order's own creation window, so each order
 * line alerts at most once however many sweeps see it.
 */
async function unusualOrderFindings(trx: DomainTrx, now: Date): Promise<Finding[]> {
  const since = new Date(now.getTime() - DEMAND_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await sql<{
    order_id: string;
    sku_id: string;
    quantity: number;
    created_at: Date;
    observations: number;
    median: number;
  }>`
    SELECT oi.order_id, oi.sku_id, oi.quantity, ord.created_at, h.observations, h.median
    FROM commerce.order_items oi
    JOIN commerce.orders ord ON ord.tenant_id = oi.tenant_id AND ord.id = oi.order_id
    CROSS JOIN LATERAL (
      SELECT COUNT(*)::int AS observations,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY p.quantity)::int AS median
      FROM commerce.order_items p
      JOIN commerce.orders po ON po.tenant_id = p.tenant_id AND po.id = p.order_id
      WHERE p.tenant_id = oi.tenant_id AND p.sku_id = oi.sku_id
        AND po.status <> 'CANCELLED' AND po.created_at < ord.created_at
    ) h
    WHERE ord.status <> 'CANCELLED'
      AND ord.created_at >= ${since} AND ord.created_at <= ${now}
      AND h.observations >= ${UNUSUAL_ORDER_MIN_OBS}
      AND oi.quantity > GREATEST(10, 3 * h.median)
    ORDER BY oi.order_id, oi.sku_id
  `.execute(trx);
  return rows.rows.map((r) => ({
    ruleId: 'unusual_order',
    skuId: r.sku_id,
    warehouseId: null,
    orderId: r.order_id,
    severity: 'warning',
    status: 'OPEN',
    windowStart: windowOf(r.created_at),
    evidence: {
      quantity: r.quantity,
      threshold: Math.max(10, 3 * r.median),
      median: r.median,
      observations: r.observations,
    },
  }));
}

function windowOf(at: Date): Date {
  return new Date(Math.floor(at.getTime() / ANOMALY_WINDOW_MS) * ANOMALY_WINDOW_MS);
}

async function insertOnce(
  trx: DomainTrx,
  ctx: ActorContext,
  finding: Finding,
  windowStart: Date,
): Promise<AnomalyRecord | undefined> {
  const id = randomUUID();
  const inserted = await trx
    .insertInto('anomalies')
    .values({
      tenant_id: ctx.tenantId,
      id,
      sku_id: finding.skuId,
      warehouse_id: finding.warehouseId,
      order_id: finding.orderId,
      rule_id: finding.ruleId,
      rule_version: ANOMALY_RULE_VERSION,
      severity: finding.severity,
      evidence: finding.evidence,
      window_start: finding.windowStart ?? windowStart,
      status: finding.status,
    })
    .onConflict((oc) => oc.constraint('anomalies_dedup_key').doNothing())
    .returning('id')
    .executeTakeFirst();
  if (!inserted) return undefined;
  return {
    id,
    ruleId: finding.ruleId,
    ruleVersion: ANOMALY_RULE_VERSION,
    severity: finding.severity,
    status: finding.status,
    skuId: finding.skuId,
    warehouseId: finding.warehouseId,
    orderId: finding.orderId,
    evidence: finding.evidence,
    windowStart: (finding.windowStart ?? windowStart).toISOString(),
  };
}

export async function listAnomalies(
  db: Kysely<Database>,
  ctx: ActorContext,
): Promise<readonly AnomalyRecord[]> {
  assertRole(ctx, ['inventory', 'support', 'approver', 'admin']);
  return withUnitOfWork(db, ctx, async (trx) => {
    const rows = await trx
      .selectFrom('anomalies')
      .selectAll()
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map((row) => ({
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
    }));
  });
}
