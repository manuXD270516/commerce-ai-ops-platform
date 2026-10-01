import { randomUUID } from 'node:crypto';
import pg from 'pg';
import {
  FIXTURES,
  createDb,
  createPool,
  hashEmbedder,
  ingestDocument,
  ingestActor,
  seedCommerceDomain,
  seedKnowledgeCorpus,
} from '@commerce/domain';

export interface LoadFixtureUrls {
  readonly migratorUrl: string;
  readonly runtimeUrl: string;
  readonly piiKey: string;
}

export interface LoadFixtureSize {
  readonly skus: number;
  readonly documents: number;
  readonly orders: number;
  readonly movements: number;
}

/** Volume from docs/rag-evals.md (prueba de carga): 500 SKUs, 100 documents, 1,000 orders, 5,000 movements. */
export const LOAD_SIZE: LoadFixtureSize = {
  skus: 500,
  documents: 100,
  orders: 1000,
  movements: 5000,
};

const ACME = FIXTURES.tenants.acme;
const WAREHOUSE = FIXTURES.warehouses.acmeEast;
const CUSTOMERS = [FIXTURES.customers.ana, FIXTURES.customers.ben];

/**
 * Resets the local database to the fixtures and adds synthetic volume to the acme tenant. Every
 * row is synthetic; the extra products are published notebooks and accessories with stock.
 */
export async function seedLoadFixture(
  urls: LoadFixtureUrls,
  size: LoadFixtureSize = LOAD_SIZE,
): Promise<{ skuIds: string[]; orderIds: string[] }> {
  await seedCommerceDomain(urls.migratorUrl, urls.piiKey);
  const client = new pg.Client({ connectionString: urls.migratorUrl });
  await client.connect();
  const skuIds: string[] = [];
  const productIds: string[] = [];
  const orderIds: string[] = [];
  try {
    await client.query('BEGIN');
    for (let i = 0; i < size.skus; i++) {
      const productId = randomUUID();
      const skuId = randomUUID();
      const notebook = i % 4 !== 0;
      const ram = [8, 16, 32, 64][i % 4] ?? 16;
      productIds.push(productId);
      skuIds.push(skuId);
      await client.query(
        `INSERT INTO commerce.products (tenant_id, id, title, category, description, status)
         VALUES ($1, $2, $3, $4, $5, 'published')`,
        [
          ACME,
          productId,
          `${notebook ? 'Notebook' : 'Accesorio'} carga ${String(i)}`,
          notebook ? 'notebook' : 'accessory',
          'Producto sintético de la prueba de carga.',
        ],
      );
      await client.query(
        `INSERT INTO commerce.skus (tenant_id, id, product_id, sku_code, price_minor, currency, ram_gb, cpu_family)
         VALUES ($1, $2, $3, $4, $5, 'USD', $6, $7)`,
        [
          ACME,
          skuId,
          productId,
          `LOAD-${String(i).padStart(4, '0')}`,
          50_000 + (i % 40) * 5_000,
          notebook ? ram : null,
          notebook ? 'zen4' : null,
        ],
      );
      await client.query(
        `INSERT INTO commerce.stock_balances (tenant_id, id, sku_id, warehouse_id, on_hand, reserved, safety_stock)
         VALUES ($1, $2, $3, $4, $5, 0, 5)`,
        [ACME, randomUUID(), skuId, WAREHOUSE, 20 + (i % 30)],
      );
    }
    for (let i = 0; i < size.orders; i++) {
      const orderId = randomUUID();
      const skuId = skuIds[i % skuIds.length] ?? FIXTURES.skus.mouse;
      orderIds.push(orderId);
      await client.query(
        `INSERT INTO commerce.orders (tenant_id, id, customer_id, status, currency, subtotal_minor, tax_minor, shipping_minor, total_minor, created_at)
         VALUES ($1, $2, $3, 'CONFIRMED', 'USD', 50000, 0, 0, 50000, now() - make_interval(hours => $4))`,
        [ACME, orderId, CUSTOMERS[i % CUSTOMERS.length], i % 240],
      );
      await client.query(
        `INSERT INTO commerce.order_items (tenant_id, id, order_id, sku_id, quantity, unit_price_minor, currency, title_snapshot, attributes_snapshot)
         VALUES ($1, $2, $3, $4, 1, 50000, 'USD', 'Producto de carga', '{}')`,
        [ACME, randomUUID(), orderId, skuId],
      );
    }
    const balances = (
      await client.query<{ id: string }>(
        'SELECT id FROM commerce.stock_balances WHERE tenant_id = $1',
        [ACME],
      )
    ).rows;
    for (let i = 0; i < size.movements; i++) {
      await client.query(
        `INSERT INTO commerce.stock_movements (tenant_id, id, balance_id, delta_on_hand, delta_reserved, reason, reference_id, recorded_at)
         VALUES ($1, $2, $3, 0, 0, 'load_fixture', $4, now() - make_interval(mins => $5))`,
        [ACME, randomUUID(), balances[i % balances.length]?.id, randomUUID(), i % 10_000],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
  const db = createDb(createPool(urls.runtimeUrl));
  try {
    await seedKnowledgeCorpus(db, hashEmbedder());
    for (let i = 0; i < size.documents; i++) {
      await ingestDocument(db, ingestActor(ACME), hashEmbedder(), {
        sourceUri: `kb://acme/products/load-${String(i)}`,
        kind: 'product',
        productId: productIds[i % productIds.length] ?? FIXTURES.products.notebook,
        title: `Ficha de carga ${String(i)}`,
        body: `## Descripción\nEquipo sintético número ${String(i)} para la prueba de carga, con batería, memoria y almacenamiento de ejemplo.\n## Uso\nOficina, desarrollo y estudio.`,
        locale: 'es',
        region: 'us-east',
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
        acl: ['all'],
        publish: true,
      });
    }
  } finally {
    await db.destroy();
  }
  return { skuIds, orderIds };
}
