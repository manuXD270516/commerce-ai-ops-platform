import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { Inventory, ProductList } from '@commerce/contracts';
import { checkInventory, getProduct, listCatalog, type CatalogSku } from '@commerce/domain';
import type { Request } from 'express';
import { DOMAIN, DomainService } from './domain.service.js';
import { parseQuery, requireUuid } from './query.js';

const CATALOG_VERSION = 'catalog.v1';

@Controller('v1')
export class CatalogController {
  constructor(@Inject(DOMAIN) private readonly domain: DomainService) {}

  @Get('products')
  async products(
    @Req() req: Request,
    @Query() query: Record<string, unknown>,
  ): Promise<ProductList> {
    const q = parseQuery(query, {
      category: 'string',
      currency: 'string',
      price_lt: 'int',
      ram_gb: 'int',
      cpu_family: 'string',
      region: 'string',
      cursor: 'string',
      limit: 'int',
    });
    const ctx = await this.domain.actorOf(req);
    const page = await listCatalog(this.domain.requireDb(), ctx, {
      category: q.category,
      currency: q.currency,
      priceLt: q.price_lt,
      ramGb: q.ram_gb,
      cpuFamily: q.cpu_family,
      region: q.region,
      cursor: q.cursor,
      limit: q.limit,
    });
    return {
      items: page.items.map(toSku),
      next_cursor: page.nextCursor,
      observed_at: page.observedAt,
      source: 'sql',
      version: CATALOG_VERSION,
    };
  }

  @Get('products/:id')
  async product(
    @Req() req: Request,
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ): Promise<ProductList> {
    const q = parseQuery(query, { region: 'string' });
    const ctx = await this.domain.actorOf(req);
    const product = await getProduct(this.domain.requireDb(), ctx, requireUuid(id, 'id'), q.region);
    return {
      items: product.skus.map(toSku),
      next_cursor: null,
      observed_at: new Date().toISOString(),
      source: 'sql',
      version: CATALOG_VERSION,
    };
  }

  @Get('inventory/:sku')
  async inventory(
    @Req() req: Request,
    @Param('sku') sku: string,
    @Query() query: Record<string, unknown>,
  ): Promise<Inventory> {
    const q = parseQuery(query, { region: 'string' });
    const ctx = await this.domain.actorOf(req);
    const view = await checkInventory(
      this.domain.requireDb(),
      ctx,
      requireUuid(sku, 'sku'),
      q.region,
    );
    return {
      sku_id: view.skuId,
      available: view.available,
      region: view.region,
      observed_at: view.observedAt,
      source: 'sql',
      ...(view.detail && {
        on_hand: view.detail.onHand,
        reserved: view.detail.reserved,
        safety_stock: view.detail.safetyStock,
      }),
    };
  }
}

function toSku(sku: CatalogSku): ProductList['items'][number] {
  return {
    id: sku.id,
    product_id: sku.productId,
    sku_code: sku.skuCode,
    title: sku.title,
    category: sku.category,
    price_minor: sku.priceMinor,
    currency: 'USD',
    ram_gb: sku.ramGb,
    cpu_family: sku.cpuFamily,
    available: sku.available,
    region: sku.region,
    observed_at: sku.observedAt,
  };
}
