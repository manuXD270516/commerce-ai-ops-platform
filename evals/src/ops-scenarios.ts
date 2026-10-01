import pg from 'pg';

/**
 * Orders with known logistic states for ops-eval@1.0.0, inserted for customer Ana (acme) with
 * timestamps relative to the moment of seeding, so delays and staleness are what the labels say.
 * They live next to the commerce-domain fixtures and use their own id range (…-9000-…).
 */
export const OPS_TENANT = '00000000-0000-4000-8000-000000000001';
export const OPS_CUSTOMER = '00000000-0000-4000-8000-000000000011';
export const MOUSE_SKU = '00000000-0000-4000-8000-000000000114';

export interface Scenario {
  readonly key: string;
  readonly orderId: string;
  readonly orderStatus: string;
  /** null: no fulfillment at all. */
  readonly shipment: {
    readonly status: string;
    readonly promisedHoursFromNow: number | null;
    readonly observedHoursAgo: number;
  } | null;
  readonly escalation: boolean;
  readonly stale: boolean;
  readonly cancellable: boolean;
}

export const SCENARIOS: readonly Scenario[] = [
  {
    key: 'lost',
    orderId: '00000000-0000-4000-9000-000000000901',
    orderStatus: 'SHIPPED',
    shipment: { status: 'LOST', promisedHoursFromNow: -24, observedHoursAgo: 1 },
    escalation: true,
    stale: false,
    cancellable: false,
  },
  {
    key: 'disputed',
    orderId: '00000000-0000-4000-9000-000000000902',
    orderStatus: 'DELIVERED',
    shipment: { status: 'DELIVERED_DISPUTED', promisedHoursFromNow: -48, observedHoursAgo: 2 },
    escalation: true,
    stale: false,
    cancellable: false,
  },
  {
    key: 'late72',
    orderId: '00000000-0000-4000-9000-000000000903',
    orderStatus: 'SHIPPED',
    shipment: { status: 'IN_TRANSIT', promisedHoursFromNow: -72, observedHoursAgo: 1 },
    escalation: true,
    stale: false,
    cancellable: false,
  },
  {
    key: 'late30',
    orderId: '00000000-0000-4000-9000-000000000904',
    orderStatus: 'SHIPPED',
    shipment: { status: 'IN_TRANSIT', promisedHoursFromNow: -30, observedHoursAgo: 1 },
    escalation: false,
    stale: false,
    cancellable: false,
  },
  {
    key: 'stale',
    orderId: '00000000-0000-4000-9000-000000000905',
    orderStatus: 'SHIPPED',
    shipment: { status: 'IN_TRANSIT', promisedHoursFromNow: 48, observedHoursAgo: 10 },
    escalation: false,
    stale: true,
    cancellable: false,
  },
  {
    key: 'ontime',
    orderId: '00000000-0000-4000-9000-000000000906',
    orderStatus: 'SHIPPED',
    shipment: { status: 'IN_TRANSIT', promisedHoursFromNow: 24, observedHoursAgo: 1 },
    escalation: false,
    stale: false,
    cancellable: false,
  },
  {
    key: 'unshipped',
    orderId: '00000000-0000-4000-9000-000000000907',
    orderStatus: 'CONFIRMED',
    shipment: null,
    escalation: false,
    stale: false,
    cancellable: true,
  },
  {
    key: 'delivered',
    orderId: '00000000-0000-4000-9000-000000000908',
    orderStatus: 'DELIVERED',
    shipment: { status: 'DELIVERED', promisedHoursFromNow: -24, observedHoursAgo: 30 },
    escalation: false,
    stale: false,
    cancellable: false,
  },
];

const hours = (n: number) => new Date(Date.now() + n * 3_600_000);

/** Idempotent per run of the eval: previous scenario rows are replaced. */
export async function seedOpsScenarios(migratorUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: migratorUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const s of SCENARIOS) {
      const fulfillmentId = s.orderId.replace('-9000-', '-9100-');
      const itemId = s.orderId.replace('-9000-', '-9200-');
      const shipmentId = s.orderId.replace('-9000-', '-9300-');
      await client.query('DELETE FROM commerce.shipments WHERE tenant_id = $1 AND id = $2', [
        OPS_TENANT,
        shipmentId,
      ]);
      await client.query(
        'DELETE FROM commerce.fulfillment_items WHERE tenant_id = $1 AND fulfillment_id = $2',
        [OPS_TENANT, fulfillmentId],
      );
      await client.query('DELETE FROM commerce.fulfillments WHERE tenant_id = $1 AND id = $2', [
        OPS_TENANT,
        fulfillmentId,
      ]);
      await client.query(
        'INSERT INTO commerce.orders (tenant_id, id, customer_id, status, currency, subtotal_minor, tax_minor, shipping_minor, total_minor) VALUES ($1, $2, $3, $4, $5, 2900, 0, 0, 2900) ON CONFLICT (tenant_id, id) DO UPDATE SET status = EXCLUDED.status, version = 1',
        [OPS_TENANT, s.orderId, OPS_CUSTOMER, s.orderStatus, 'USD'],
      );
      await client.query(
        "INSERT INTO commerce.order_items (tenant_id, id, order_id, sku_id, quantity, unit_price_minor, currency, title_snapshot, attributes_snapshot) VALUES ($1, $2, $3, $4, 1, 2900, 'USD', 'Mouse', '{}') ON CONFLICT (tenant_id, id) DO NOTHING",
        [OPS_TENANT, itemId, s.orderId, MOUSE_SKU],
      );
      if (!s.shipment) continue;
      await client.query(
        "INSERT INTO commerce.fulfillments (tenant_id, id, order_id, status) VALUES ($1, $2, $3, 'SHIPPED')",
        [OPS_TENANT, fulfillmentId, s.orderId],
      );
      await client.query(
        'INSERT INTO commerce.fulfillment_items (tenant_id, id, fulfillment_id, order_item_id, quantity) VALUES ($1, $2, $3, $4, 1)',
        [OPS_TENANT, s.orderId.replace('-9000-', '-9400-'), fulfillmentId, itemId],
      );
      await client.query(
        "INSERT INTO commerce.shipments (tenant_id, id, fulfillment_id, carrier, tracking_ref, status, last_observed_at, estimated_delivery_at, source_mode) VALUES ($1, $2, $3, 'demo-carrier', $4, $5, $6, $7, 'simulated')",
        [
          OPS_TENANT,
          shipmentId,
          fulfillmentId,
          `SIM-OPS-${s.key.toUpperCase()}`,
          s.shipment.status,
          hours(-s.shipment.observedHoursAgo),
          s.shipment.promisedHoursFromNow === null ? null : hours(s.shipment.promisedHoursFromNow),
        ],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}
