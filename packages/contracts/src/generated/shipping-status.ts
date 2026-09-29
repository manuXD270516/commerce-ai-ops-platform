/* Generated from schemas/ by scripts/generate-types.mjs. Do not edit. */

export interface ShippingStatus {
  order_id: string;
  order_status: string;
  /**
   * @maxItems 20
   */
  shipments: {
    id: string;
    status: string;
    tracking_ref: string;
    stale: boolean;
    source_mode: 'simulated';
    last_observed_at: string;
    /**
     * @maxItems 20
     */
    items: {
      order_item_id: string;
      quantity: number;
    }[];
  }[];
  observed_at: string;
  source: 'sql';
}
