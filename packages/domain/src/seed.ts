import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { encryptEmail, hashEmail } from './pii.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
export const COMMERCE_FIXTURE_DIR = join(repoRoot, 'evals/fixtures/commerce-domain/0.3.0');

interface SeedFile {
  tenants: { id: string; slug: string; name: string }[];
  memberships: { tenant: string; id: string; subjectId: string; role: string }[];
  customers: { tenant: string; id: string; subjectId: string; name: string; email: string }[];
  products: {
    tenant: string;
    id: string;
    title: string;
    category: string;
    description: string;
    status: string;
  }[];
  skus: {
    tenant: string;
    id: string;
    productId: string;
    skuCode: string;
    priceMinor: number;
    ramGb?: number;
    cpuFamily?: string;
  }[];
  warehouses: { tenant: string; id: string; name: string; region: string }[];
  stock: {
    tenant: string;
    id: string;
    skuId: string;
    warehouseId: string;
    onHand: number;
    reserved: number;
    safetyStock: number;
  }[];
  orders: {
    tenant: string;
    id: string;
    customerId: string;
    status: string;
    subtotalMinor: number;
    taxMinor: number;
    shippingMinor: number;
    items: {
      id: string;
      skuId: string;
      quantity: number;
      unitPriceMinor: number;
      titleSnapshot: string;
    }[];
  }[];
  fulfillments: {
    tenant: string;
    id: string;
    orderId: string;
    status: string;
    items: { id: string; orderItemId: string; quantity: number }[];
  }[];
  shipments: {
    tenant: string;
    id: string;
    fulfillmentId: string;
    carrier: string;
    trackingRef: string;
    status: string;
    lastObservedAt: string;
    estimatedDeliveryAt?: string;
  }[];
  observations?: {
    tenant: string;
    id: string;
    skuId: string;
    warehouseId: string;
    countedQuantity: number;
    observedAt: string;
  }[];
}

export async function seedCommerceDomain(migratorUrl: string, piiKey: string): Promise<void> {
  const raw = await readFile(join(COMMERCE_FIXTURE_DIR, 'seed.json'));
  const manifest = JSON.parse(
    await readFile(join(COMMERCE_FIXTURE_DIR, 'manifest.json'), 'utf8'),
  ) as {
    files: { path: string; sha256: string }[];
  };
  const expected = manifest.files.find((f) => f.path === 'seed.json')?.sha256;
  const actual = createHash('sha256').update(raw).digest('hex');
  if (actual !== expected) {
    throw new Error(`commerce-domain fixture checksum ${actual} != ${expected}`);
  }
  const seed = JSON.parse(raw.toString('utf8')) as SeedFile;
  const tenantId = Object.fromEntries(seed.tenants.map((t) => [t.slug, t.id]));
  const client = new pg.Client({ connectionString: migratorUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE commerce.tenants CASCADE');
    for (const tenant of seed.tenants) {
      await client.query('INSERT INTO commerce.tenants (id, slug, name) VALUES ($1,$2,$3)', [
        tenant.id,
        tenant.slug,
        tenant.name,
      ]);
    }
    for (const row of seed.memberships) {
      await client.query(
        'INSERT INTO commerce.memberships (tenant_id, id, subject_id, role) VALUES ($1,$2,$3,$4)',
        [tenantId[row.tenant], row.id, row.subjectId, row.role],
      );
    }
    for (const row of seed.customers) {
      await client.query(
        `INSERT INTO commerce.customers
          (tenant_id, id, subject_id, display_name, email_ciphertext, email_hash)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          tenantId[row.tenant],
          row.id,
          row.subjectId,
          row.name,
          encryptEmail(row.email, piiKey),
          hashEmail(row.email),
        ],
      );
    }
    for (const row of seed.products) {
      await client.query(
        `INSERT INTO commerce.products (tenant_id, id, title, category, description, status)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [tenantId[row.tenant], row.id, row.title, row.category, row.description, row.status],
      );
    }
    for (const row of seed.skus) {
      await client.query(
        `INSERT INTO commerce.skus
          (tenant_id, id, product_id, sku_code, price_minor, currency, ram_gb, cpu_family)
         VALUES ($1,$2,$3,$4,$5,'USD',$6,$7)`,
        [
          tenantId[row.tenant],
          row.id,
          row.productId,
          row.skuCode,
          row.priceMinor,
          row.ramGb ?? null,
          row.cpuFamily ?? null,
        ],
      );
    }
    for (const row of seed.warehouses) {
      await client.query(
        'INSERT INTO commerce.warehouses (tenant_id, id, name, region) VALUES ($1,$2,$3,$4)',
        [tenantId[row.tenant], row.id, row.name, row.region],
      );
    }
    for (const row of seed.stock) {
      await client.query(
        `INSERT INTO commerce.stock_balances
          (tenant_id, id, sku_id, warehouse_id, on_hand, reserved, safety_stock)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          tenantId[row.tenant],
          row.id,
          row.skuId,
          row.warehouseId,
          row.onHand,
          row.reserved,
          row.safetyStock,
        ],
      );
    }
    for (const order of seed.orders) {
      await client.query(
        `INSERT INTO commerce.orders
          (tenant_id, id, customer_id, status, currency, subtotal_minor, tax_minor, shipping_minor, total_minor)
         VALUES ($1,$2,$3,$4,'USD',$5,$6,$7,$8)`,
        [
          tenantId[order.tenant],
          order.id,
          order.customerId,
          order.status,
          order.subtotalMinor,
          order.taxMinor,
          order.shippingMinor,
          order.subtotalMinor + order.taxMinor + order.shippingMinor,
        ],
      );
      for (const item of order.items) {
        await client.query(
          `INSERT INTO commerce.order_items
            (tenant_id, id, order_id, sku_id, quantity, unit_price_minor, currency, title_snapshot, attributes_snapshot)
           VALUES ($1,$2,$3,$4,$5,$6,'USD',$7,'{}'::jsonb)`,
          [
            tenantId[order.tenant],
            item.id,
            order.id,
            item.skuId,
            item.quantity,
            item.unitPriceMinor,
            item.titleSnapshot,
          ],
        );
      }
    }
    for (const row of seed.fulfillments) {
      await client.query(
        'INSERT INTO commerce.fulfillments (tenant_id, id, order_id, status) VALUES ($1,$2,$3,$4)',
        [tenantId[row.tenant], row.id, row.orderId, row.status],
      );
      for (const item of row.items) {
        await client.query(
          `INSERT INTO commerce.fulfillment_items (tenant_id, id, fulfillment_id, order_item_id, quantity)
           VALUES ($1,$2,$3,$4,$5)`,
          [tenantId[row.tenant], item.id, row.id, item.orderItemId, item.quantity],
        );
      }
    }
    for (const row of seed.shipments) {
      await client.query(
        `INSERT INTO commerce.shipments
          (tenant_id, id, fulfillment_id, carrier, tracking_ref, status, last_observed_at,
           estimated_delivery_at, source_mode)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'simulated')`,
        [
          tenantId[row.tenant],
          row.id,
          row.fulfillmentId,
          row.carrier,
          row.trackingRef,
          row.status,
          row.lastObservedAt,
          row.estimatedDeliveryAt ?? null,
        ],
      );
    }
    for (const row of seed.observations ?? []) {
      await client.query(
        `INSERT INTO commerce.stock_observations
          (tenant_id, id, sku_id, warehouse_id, counted_quantity, observed_at, source)
         VALUES ($1,$2,$3,$4,$5,$6,'simulated')`,
        [
          tenantId[row.tenant],
          row.id,
          row.skuId,
          row.warehouseId,
          row.countedQuantity,
          row.observedAt,
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
