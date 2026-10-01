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
    estimated_delivery_at?: string | null;
    delay_hours?: number | null;
    /**
     * @maxItems 20
     */
    items: {
      order_item_id: string;
      quantity: number;
    }[];
  }[];
  escalation?: {
    required: boolean;
    rule_version: string;
    reasons: ('delay_over_48h' | 'delivered_disputed' | 'shipment_lost')[];
  };
  observed_at: string;
  source: 'sql';
}
