import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_BUDGETS,
  EMPTY_USAGE,
  FIXTURES,
  POLICY_VERSION,
  anomalyDetectorActor,
  assessEscalation,
  createAgentRun,
  createDb,
  createPool,
  detectAnomalies,
  hashEmbedder,
  migrate,
  seedCommerceDomain,
  seedKnowledgeCorpus,
  type ActorContext,
  type ShipmentView,
} from '@commerce/domain';
import type { ToolResult } from '@commerce/tools';
import {
  Meter,
  ToolGateway,
  explainInventory,
  investigateOrder,
  recommendProductsForRun,
  routeMessage,
  type SpecialistDeps,
  type SpecialistProfile,
} from '../src/index.js';

const { DATABASE_ADMIN_URL, DATABASE_MIGRATOR_URL, DATABASE_URL, PII_ENCRYPTION_KEY } = process.env;
const enabled = Boolean(
  DATABASE_ADMIN_URL && DATABASE_MIGRATOR_URL && DATABASE_URL && PII_ENCRYPTION_KEY,
);

const ACME = FIXTURES.tenants.acme;
const ctxOf = (
  role: ActorContext['role'],
  subjectId: string,
  customerId?: string,
): ActorContext => ({
  tenantId: ACME,
  subjectId,
  role,
  policyVersion: POLICY_VERSION,
  ...(customerId ? { customerId } : {}),
});
const ana = ctxOf('customer', FIXTURES.subjects.ana, FIXTURES.customers.ana);
const inventoryOp = ctxOf('inventory', FIXTURES.subjects.acmeInventory);

describe('versioned escalation rule', () => {
  const shipment = (over: Partial<ShipmentView>): ShipmentView => ({
    id: randomUUID(),
    fulfillmentId: randomUUID(),
    status: 'IN_TRANSIT',
    trackingRef: 'T',
    carrier: 'demo',
    lastObservedAt: '2026-10-01T00:00:00.000Z',
    estimatedDeliveryAt: null,
    delayHours: null,
    stale: false,
    sourceMode: 'simulated',
    items: [],
    ...over,
  });

  it('escalates LOST, DELIVERED_DISPUTED and delays over 48 h, nothing else', () => {
    expect(assessEscalation([shipment({ delayHours: 48 })])).toEqual({
      required: false,
      ruleVersion: 'escalation.v1',
      reasons: [],
    });
    expect(assessEscalation([shipment({ delayHours: 49 })]).reasons).toEqual(['delay_over_48h']);
    expect(
      assessEscalation([shipment({ status: 'LOST' }), shipment({ status: 'DELIVERED_DISPUTED' })])
        .reasons,
    ).toEqual(['delivered_disputed', 'shipment_lost']);
    expect(assessEscalation([shipment({ stale: true })]).required).toBe(false);
  });
});

describe.skipIf(!enabled)('specialists against PostgreSQL (M7)', () => {
  const db = createDb(createPool(DATABASE_URL!));
  const owner = new pg.Client({ connectionString: DATABASE_MIGRATOR_URL });

  /** A gateway whose hook can change the world or fail a tool, like a slow or broken dependency. */
  class HookedGateway extends ToolGateway {
    constructor(
      ctx: ActorContext,
      runId: string,
      private readonly hook: (tool: string) => Promise<ToolResult | undefined>,
    ) {
      super(db, ctx, runId, new Meter(DEFAULT_BUDGETS, EMPTY_USAGE));
    }
    override async call(profile: SpecialistProfile, tool: string, args: Record<string, unknown>) {
      return (await this.hook(tool)) ?? super.call(profile, tool, args);
    }
  }

  async function deps(
    ctx: ActorContext,
    hook: (tool: string) => Promise<ToolResult | undefined> = () => Promise.resolve(undefined),
  ): Promise<SpecialistDeps> {
    const run = await createAgentRun(db, ctx, {
      message: 'test',
      promptVersion: 'synth.v1',
      modelVersion: 'template-synth.v1',
      routerVersion: 'router.v1',
    });
    return {
      db,
      ctx,
      gateway: new HookedGateway(ctx, run.id, hook),
      embedder: hashEmbedder(),
      region: 'us-east',
      locale: 'es',
    };
  }

  async function orderWithShipment(status: string, estimatedHoursAgo: number | null) {
    const orderId = randomUUID();
    const itemId = randomUUID();
    const fulfillmentId = randomUUID();
    await owner.query(
      `INSERT INTO commerce.orders (tenant_id, id, customer_id, status, currency, subtotal_minor, tax_minor, shipping_minor, total_minor)
       VALUES ($1, $2, $3, 'SHIPPED', 'USD', 2900, 0, 0, 2900)`,
      [ACME, orderId, FIXTURES.customers.ana],
    );
    await owner.query(
      `INSERT INTO commerce.order_items (tenant_id, id, order_id, sku_id, quantity, unit_price_minor, currency, title_snapshot, attributes_snapshot)
       VALUES ($1, $2, $3, $4, 1, 2900, 'USD', 'Mouse', '{}')`,
      [ACME, itemId, orderId, FIXTURES.skus.mouse],
    );
    await owner.query(
      `INSERT INTO commerce.fulfillments (tenant_id, id, order_id, status) VALUES ($1, $2, $3, 'SHIPPED')`,
      [ACME, fulfillmentId, orderId],
    );
    await owner.query(
      `INSERT INTO commerce.fulfillment_items (tenant_id, id, fulfillment_id, order_item_id, quantity) VALUES ($1, $2, $3, $4, 1)`,
      [ACME, randomUUID(), fulfillmentId, itemId],
    );
    await owner.query(
      `INSERT INTO commerce.shipments (tenant_id, id, fulfillment_id, carrier, tracking_ref, status, last_observed_at, estimated_delivery_at, source_mode)
       VALUES ($1, $2, $3, 'demo-carrier', $4, $5, now() - interval '1 hour', $6, 'simulated')`,
      [
        ACME,
        randomUUID(),
        fulfillmentId,
        `SIM-${status}`,
        status,
        estimatedHoursAgo === null ? null : new Date(Date.now() - estimatedHoursAgo * 3_600_000),
      ],
    );
    return orderId;
  }

  const tickets = async () =>
    (await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM commerce.tickets')).rows[0]
      ?.n;

  beforeAll(async () => {
    await migrate({
      adminUrl: DATABASE_ADMIN_URL!,
      migratorUrl: DATABASE_MIGRATOR_URL!,
      runtimeUrl: DATABASE_URL!,
    });
    await seedCommerceDomain(DATABASE_MIGRATOR_URL!, PII_ENCRYPTION_KEY!);
    await seedKnowledgeCorpus(db, hashEmbedder());
    await owner.connect();
  }, 60_000);

  afterAll(async () => {
    await owner.end();
    await db.destroy();
  });

  it('lost shipment: evidence and escalation, no invented cause and no ticket without consent', async () => {
    const orderId = await orderWithShipment('LOST', null);
    const before = await tickets();
    const finding = await investigateOrder(
      await deps(ana),
      routeMessage(`¿Qué pasó con ${orderId}?`).slots,
    );
    expect(finding.escalation).toMatchObject({ required: true, reasons: ['shipment_lost'] });
    expect(
      finding.facts.some((f) => f.text.includes('LOST') && f.evidence.kind === 'shipment'),
    ).toBe(true);
    expect(finding.uncertainty.join(' ')).toContain('no hay una causa registrada');
    expect(finding.nextSteps.join(' ')).toContain('sólo lo creo si lo confirmás');
    expect(await tickets()).toBe(before);
  });

  it('partial and stale shipment: both packages, labelled inference and no confirmed delivery date', async () => {
    const finding = await investigateOrder(
      await deps(ana),
      routeMessage(`Mi pedido ${FIXTURES.orders.anaPartial} llegó incompleto`).slots,
    );
    const packages = finding.facts.filter((f) => f.evidence.kind === 'shipment');
    expect(packages.map((p) => p.text.slice(0, 18))).toEqual([
      'Paquete SIM-401-A ',
      'Paquete SIM-401-B ',
    ]);
    expect(finding.inferences.join(' ')).toMatch(/^Inferencia: es un envío parcial/);
    expect(finding.uncertainty.join(' ')).toContain('no puedo confirmar una fecha de entrega');
    expect(finding.uncertainty.join(' ')).toContain('2026-09-20T12:00:00.000Z');
    expect(finding.escalation?.reasons).toContain('delay_over_48h');
    expect(finding.facts.some((f) => f.evidence.kind === 'policy')).toBe(true);
  });

  it('unavailable tracking degrades to partial without asserting any date', async () => {
    const finding = await investigateOrder(
      await deps(ana, (tool) =>
        Promise.resolve(
          tool === 'get_shipping_status'
            ? ({
                ok: false,
                error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'carrier down' },
                meta: {
                  tool,
                  classification: 'READ',
                  toolCallId: randomUUID(),
                  observedAt: new Date().toISOString(),
                },
              } satisfies ToolResult)
            : undefined,
        ),
      ),
      routeMessage(`Estado de ${FIXTURES.orders.anaPartial}`).slots,
    );
    expect(finding.status).toBe('partial');
    expect(finding.uncertainty.join(' ')).toContain('no afirmo ninguna fecha de entrega');
    expect(finding.facts.some((f) => f.evidence.kind === 'shipment')).toBe(false);
  });

  it('escalates a delay over 48 h and DELIVERED_DISPUTED, but not a 30 h delay', async () => {
    const late = await orderWithShipment('IN_TRANSIT', 50);
    const mild = await orderWithShipment('IN_TRANSIT', 30);
    const disputed = await orderWithShipment('DELIVERED_DISPUTED', null);
    const run = async (id: string) =>
      (await investigateOrder(await deps(ana), routeMessage(`Estado de ${id}`).slots)).escalation;
    expect(await run(late)).toMatchObject({ required: true, reasons: ['delay_over_48h'] });
    expect(await run(mild)).toMatchObject({ required: false, reasons: [] });
    expect(await run(disputed)).toMatchObject({ required: true, reasons: ['delivered_disputed'] });
  });

  it('missing or foreign order: not found, with nothing revealed', async () => {
    for (const id of [randomUUID(), FIXTURES.orders.benConfirmed, FIXTURES.orders.caraPlaced]) {
      const finding = await investigateOrder(
        await deps(ana),
        routeMessage(`Estado de ${id}`).slots,
      );
      expect(finding).toMatchObject({ status: 'not_found', facts: [] });
    }
  });

  it('drops a candidate that loses stock while the answer is being prepared', async () => {
    const finding = await recommendProductsForRun(
      await deps(ana, async (tool) => {
        if (tool === 'check_inventory') {
          await owner.query(
            'UPDATE commerce.stock_balances SET reserved = on_hand WHERE tenant_id = $1 AND sku_id = $2',
            [ACME, FIXTURES.skus.nb32],
          );
        }
        return undefined;
      }),
      'Notebook para programar por menos de USD 1.500',
      routeMessage('Notebook para programar por menos de USD 1.500').slots,
    );
    try {
      expect(finding.items?.map((i) => i.skuCode)).toEqual(['NB-DEV-16']);
      expect(finding.uncertainty.join(' ')).toContain('NB-DEV-32 perdió disponibilidad');
    } finally {
      await owner.query(
        'UPDATE commerce.stock_balances SET reserved = 0 WHERE tenant_id = $1 AND sku_id = $2',
        [ACME, FIXTURES.skus.nb32],
      );
    }
  });

  it('keeps budget, currency and attributes strict and uses preferences only to order', async () => {
    const message = 'Busco notebook de desarrollo por menos de USD 1.500';
    const finding = await recommendProductsForRun(
      await deps(ana),
      message,
      routeMessage(message).slots,
    );
    expect(finding.items?.map((i) => i.skuCode)).toEqual(['NB-DEV-32', 'NB-DEV-16']);
    expect(finding.items?.every((i) => i.priceMinor < 150_000 && i.currency === 'USD')).toBe(true);
    expect(finding.items?.[0]?.justification).toContain('preferencia, no requisito');
    const none = 'Notebook de 64GB por menos de USD 1.500';
    const empty = await recommendProductsForRun(await deps(ana), none, routeMessage(none).slots);
    expect(empty).toMatchObject({ status: 'no_candidates' });
    expect(empty.nextSteps.join(' ')).toContain('No relajo esas condiciones');
  });

  it('explains alerts from the rule id, version and recorded evidence without changing stock', async () => {
    await detectAnomalies(db, anomalyDetectorActor(ACME), new Date('2026-09-29T12:00:00.000Z'));
    const balances = async () =>
      (
        await owner.query<{ s: string }>(
          `SELECT string_agg(sku_id::text || ':' || on_hand || ':' || reserved, ',' ORDER BY sku_id) AS s FROM commerce.stock_balances`,
        )
      ).rows[0]?.s;
    const before = await balances();
    const d = await deps(inventoryOp);
    const finding = await explainInventory(
      d,
      routeMessage('Explícame la discrepancia de inventario de NB-DEV-32').slots,
    );
    const discrepancy = finding.alerts?.find((a) => a.ruleId === 'discrepancy');
    expect(discrepancy?.explanation).toBe(
      'Regla discrepancy (anomaly.v1): el último conteo (1, 2026-09-29T00:00:00.000Z) difiere del balance on_hand 4.',
    );
    expect(finding.alerts?.every((a) => a.skuId === FIXTURES.skus.nb32)).toBe(true);
    expect(
      finding.facts.some((f) => f.text.startsWith(`Balance actual de ${FIXTURES.skus.nb32}`)),
    ).toBe(true);
    expect(
      d.gateway.calls.every((c) => ['search_products', 'check_inventory'].includes(c.tool)),
    ).toBe(true);
    expect(await balances()).toBe(before);
    const forCustomer = await explainInventory(
      await deps(ana),
      routeMessage('alertas de stock').slots,
    );
    expect(forCustomer.status).toBe('forbidden');
  });
});
