import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { ActorContext, Role } from './access.js';
import { MAX_PAGE } from './constants.js';
import type { Database } from './db.js';
import { DomainError } from './errors.js';
import { appendAudit, withUnitOfWork } from './uow.js';

export interface CatalogFilters {
  readonly productId?: string;
  readonly category?: string;
  readonly currency?: string;
  readonly priceLt?: number;
  readonly ramGb?: number;
  readonly cpuFamily?: string;
  readonly region?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface CatalogSku {
  readonly id: string;
  readonly productId: string;
  readonly skuCode: string;
  readonly title: string;
  readonly category: string;
  readonly priceMinor: number;
  readonly currency: string;
  readonly ramGb: number | null;
  readonly cpuFamily: string | null;
  readonly available: number;
  readonly region: string;
  readonly observedAt: string;
}

export interface CatalogPage {
  readonly items: readonly CatalogSku[];
  readonly nextCursor: string | null;
  readonly observedAt: string;
}

interface Cursor {
  readonly priceMinor: number;
  readonly skuCode: string;
}

export async function listCatalog(
  db: Kysely<Database>,
  ctx: ActorContext,
  filters: CatalogFilters,
): Promise<CatalogPage> {
  if (filters.currency !== undefined && filters.currency !== 'USD') {
    throw new DomainError('VALIDATION_ERROR', 'Only USD is supported', { field: 'currency' });
  }
  for (const [field, value] of [
    ['price_lt', filters.priceLt],
    ['ram_gb', filters.ramGb],
    ['limit', filters.limit],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new DomainError('VALIDATION_ERROR', `${field} must be a non-negative integer`, {
        field,
      });
    }
  }
  if (filters.limit !== undefined && (filters.limit < 1 || filters.limit > MAX_PAGE)) {
    throw new DomainError('VALIDATION_ERROR', `limit must be between 1 and ${MAX_PAGE}`, {
      field: 'limit',
    });
  }
  const limit = filters.limit ?? 20;
  const cursor = filters.cursor ? decodeCursor(filters.cursor) : undefined;
  const observedAt = new Date().toISOString();

  return withUnitOfWork(db, ctx, async (trx) => {
    let query = trx
      .selectFrom('skus as s')
      .innerJoin('products as p', (join) =>
        join.onRef('p.id', '=', 's.product_id').onRef('p.tenant_id', '=', 's.tenant_id'),
      )
      .innerJoin('stock_balances as b', (join) =>
        join.onRef('b.sku_id', '=', 's.id').onRef('b.tenant_id', '=', 's.tenant_id'),
      )
      .innerJoin('warehouses as w', (join) =>
        join.onRef('w.id', '=', 'b.warehouse_id').onRef('w.tenant_id', '=', 's.tenant_id'),
      )
      .select([
        's.id as id',
        's.product_id as productId',
        's.sku_code as skuCode',
        'p.title as title',
        'p.category as category',
        's.price_minor as priceMinor',
        's.currency as currency',
        's.ram_gb as ramGb',
        's.cpu_family as cpuFamily',
        'w.region as region',
        sql<number>`b.on_hand - b.reserved`.as('available'),
      ])
      .where('p.status', '=', 'published')
      .where('s.currency', '=', filters.currency ?? 'USD');

    if (filters.productId) query = query.where('p.id', '=', filters.productId);
    if (filters.category) query = query.where('p.category', '=', filters.category);
    if (filters.priceLt !== undefined)
      query = query.where('s.price_minor', '<', String(filters.priceLt));
    if (filters.ramGb !== undefined) query = query.where('s.ram_gb', '=', filters.ramGb);
    if (filters.cpuFamily) query = query.where('s.cpu_family', '=', filters.cpuFamily);
    if (filters.region) query = query.where('w.region', '=', filters.region);
    if (cursor) {
      query = query.where(
        sql<boolean>`(s.price_minor, s.sku_code) > (${cursor.priceMinor}::bigint, ${cursor.skuCode})`,
      );
    }

    const rows = await query
      .orderBy('s.price_minor')
      .orderBy('s.sku_code')
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const overflow = rows.length > limit ? rows[limit] : undefined;
    await appendAudit(trx, ctx, {
      action: filters.productId ? 'catalog.read' : 'catalog.list',
      resourceType: 'product',
      resourceId: filters.productId,
      outcome: filters.productId && page.length === 0 ? 'DENIED' : 'ALLOWED',
    });
    const items: CatalogSku[] = page.map((row) => ({
      id: row.id,
      productId: row.productId,
      skuCode: row.skuCode,
      title: row.title,
      category: row.category,
      priceMinor: Number(row.priceMinor),
      currency: row.currency,
      ramGb: row.ramGb,
      cpuFamily: row.cpuFamily,
      available: row.available,
      region: row.region,
      observedAt,
    }));
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        overflow && last
          ? encodeCursor({ priceMinor: last.priceMinor, skuCode: last.skuCode })
          : null,
      observedAt,
    };
  });
}

export async function getProduct(
  db: Kysely<Database>,
  ctx: ActorContext,
  productId: string,
  region?: string,
): Promise<{ productId: string; title: string; category: string; skus: readonly CatalogSku[] }> {
  const page = await listCatalog(db, ctx, { productId, region, limit: MAX_PAGE });
  const first = page.items[0];
  if (!first) throw new DomainError('NOT_FOUND', 'Product not found');
  return { productId, title: first.title, category: first.category, skus: page.items };
}

/** Roles that may see stock internals and unpublished SKUs; everyone else sees availability only. */
const INVENTORY_DETAIL_ROLES: readonly Role[] = ['inventory', 'support', 'admin'];
const UNPUBLISHED_ROLES: readonly Role[] = ['inventory', 'admin'];

export interface InventoryView {
  readonly skuId: string;
  readonly available: number;
  readonly region: string;
  readonly observedAt: string;
  readonly detail?: {
    readonly onHand: number;
    readonly reserved: number;
    readonly safetyStock: number;
  };
}

export async function checkInventory(
  db: Kysely<Database>,
  ctx: ActorContext,
  skuId: string,
  region?: string,
): Promise<InventoryView> {
  const result = await withUnitOfWork(db, ctx, async (trx) => {
    let query = trx
      .selectFrom('stock_balances as b')
      .innerJoin('warehouses as w', (join) =>
        join.onRef('w.id', '=', 'b.warehouse_id').onRef('w.tenant_id', '=', 'b.tenant_id'),
      )
      .innerJoin('skus as s', (join) =>
        join.onRef('s.id', '=', 'b.sku_id').onRef('s.tenant_id', '=', 'b.tenant_id'),
      )
      .innerJoin('products as p', (join) =>
        join.onRef('p.id', '=', 's.product_id').onRef('p.tenant_id', '=', 's.tenant_id'),
      )
      .select([
        'w.region as region',
        sql<number>`sum(b.on_hand)::int`.as('onHand'),
        sql<number>`sum(b.reserved)::int`.as('reserved'),
        sql<number>`sum(b.safety_stock)::int`.as('safetyStock'),
      ])
      .where('b.sku_id', '=', skuId)
      .groupBy('w.region');
    if (region) query = query.where('w.region', '=', region);
    if (!UNPUBLISHED_ROLES.includes(ctx.role)) query = query.where('p.status', '=', 'published');
    const rows = await query.execute();
    const row = rows[0];
    if (rows.length > 1) {
      throw new DomainError('VALIDATION_ERROR', 'region is required for multi-region SKUs', {
        field: 'region',
      });
    }
    await appendAudit(trx, ctx, {
      action: 'inventory.read',
      resourceType: 'sku',
      resourceId: skuId,
      outcome: row ? 'ALLOWED' : 'DENIED',
    });
    return row;
  });
  if (!result) throw new DomainError('NOT_FOUND', 'Inventory not found');
  const view: InventoryView = {
    skuId,
    available: result.onHand - result.reserved,
    region: result.region,
    observedAt: new Date().toISOString(),
  };
  if (!INVENTORY_DETAIL_ROLES.includes(ctx.role)) return view;
  return {
    ...view,
    detail: {
      onHand: result.onHand,
      reserved: result.reserved,
      safetyStock: result.safetyStock,
    },
  };
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.priceMinor}|${cursor.skuCode}`, 'utf8').toString('base64url');
}

function decodeCursor(value: string): Cursor {
  const raw = Buffer.from(value, 'base64url').toString('utf8');
  const sep = raw.indexOf('|');
  if (sep < 1) throw new DomainError('VALIDATION_ERROR', 'Invalid cursor');
  const priceMinor = Number(raw.slice(0, sep));
  const skuCode = raw.slice(sep + 1);
  if (!Number.isInteger(priceMinor) || skuCode.length === 0) {
    throw new DomainError('VALIDATION_ERROR', 'Invalid cursor');
  }
  return { priceMinor, skuCode };
}
