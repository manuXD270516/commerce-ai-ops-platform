/* Generated from schemas/ by scripts/generate-types.mjs. Do not edit. */

export interface Order {
  id: string;
  customer_id: string;
  status: string;
  currency: 'USD';
  total_minor: number;
  version: number;
  /**
   * @maxItems 50
   */
  items: {
    id: string;
    sku_id: string;
    quantity: number;
    unit_price_minor: number;
    title_snapshot: string;
  }[];
  observed_at: string;
  source: 'sql';
}
