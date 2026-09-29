-- NULL sku/warehouse/order columns made the original UNIQUE constraint ineffective:
-- PostgreSQL treats NULLs as distinct. NULLS NOT DISTINCT (PG15+) makes alert dedup hold.
ALTER TABLE commerce.anomalies
  DROP CONSTRAINT anomalies_tenant_id_rule_id_sku_id_warehouse_id_order_id_wi_key;

ALTER TABLE commerce.anomalies
  ADD CONSTRAINT anomalies_dedup_key
  UNIQUE NULLS NOT DISTINCT (tenant_id, rule_id, sku_id, warehouse_id, order_id, window_start);
