/* Generated from schemas/ by scripts/generate-types.mjs. Do not edit. */

/**
 * on_hand, reserved and safety_stock are present only for inventory, support and admin roles.
 */
export interface Inventory {
  sku_id: string;
  available: number;
  on_hand?: number;
  reserved?: number;
  safety_stock?: number;
  region: string;
  observed_at: string;
  source: 'sql';
}
