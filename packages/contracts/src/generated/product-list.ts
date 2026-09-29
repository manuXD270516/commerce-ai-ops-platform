/* Generated from schemas/ by scripts/generate-types.mjs. Do not edit. */

export interface ProductList {
  /**
   * @maxItems 50
   */
  items: CatalogSku[];
  next_cursor: string | null;
  observed_at: string;
  source: 'sql';
  version: string;
}
export interface CatalogSku {
  id: string;
  product_id: string;
  sku_code: string;
  title: string;
  category: string;
  price_minor: number;
  currency: 'USD';
  ram_gb?: number | null;
  cpu_family?: string | null;
  available: number;
  region: string;
  observed_at: string;
}
