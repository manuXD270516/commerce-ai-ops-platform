-- FORCE RLS so table owners (migrator) still bypass, but runtime never does.
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'memberships',
    'customers',
    'products',
    'skus',
    'product_attributes',
    'warehouses',
    'stock_balances',
    'reservations',
    'stock_movements',
    'stock_observations',
    'orders',
    'order_items',
    'fulfillments',
    'fulfillment_items',
    'shipments',
    'tracking_events',
    'tickets',
    'documents',
    'document_versions',
    'chunks',
    'agent_runs',
    'run_events',
    'checkpoints',
    'evidence',
    'action_requests',
    'approvals',
    'action_executions',
    'audit_events',
    'outbox',
    'inbox',
    'idempotency_records',
    'anomalies'
  ]
  LOOP
    EXECUTE format('ALTER TABLE commerce.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON commerce.%I
         USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      tbl
    );
  END LOOP;
END $$;

-- Customers may only read their own orders and related logistics/support rows.
CREATE OR REPLACE FUNCTION commerce.customer_owns_order(order_tenant uuid, order_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM commerce.orders o
    WHERE o.tenant_id = order_tenant
      AND o.id = order_id
      AND o.customer_id = nullif(current_setting('app.customer_id', true), '')::uuid
  )
$$;

CREATE POLICY customer_order_ownership ON commerce.orders
  AS RESTRICTIVE
  USING (
    current_setting('app.role', true) IS DISTINCT FROM 'customer'
    OR customer_id = nullif(current_setting('app.customer_id', true), '')::uuid
  )
  WITH CHECK (
    current_setting('app.role', true) IS DISTINCT FROM 'customer'
    OR customer_id = nullif(current_setting('app.customer_id', true), '')::uuid
  );

CREATE POLICY customer_order_item_ownership ON commerce.order_items
  AS RESTRICTIVE
  USING (
    current_setting('app.role', true) IS DISTINCT FROM 'customer'
    OR commerce.customer_owns_order(tenant_id, order_id)
  );

CREATE POLICY customer_fulfillment_ownership ON commerce.fulfillments
  AS RESTRICTIVE
  USING (
    current_setting('app.role', true) IS DISTINCT FROM 'customer'
    OR commerce.customer_owns_order(tenant_id, order_id)
  );

CREATE POLICY customer_fulfillment_item_ownership ON commerce.fulfillment_items
  AS RESTRICTIVE
  USING (
    current_setting('app.role', true) IS DISTINCT FROM 'customer'
    OR EXISTS (
      SELECT 1 FROM commerce.fulfillments f
      WHERE f.tenant_id = fulfillment_items.tenant_id
        AND f.id = fulfillment_items.fulfillment_id
        AND commerce.customer_owns_order(f.tenant_id, f.order_id)
    )
  );

CREATE POLICY customer_shipment_ownership ON commerce.shipments
  AS RESTRICTIVE
  USING (
    current_setting('app.role', true) IS DISTINCT FROM 'customer'
    OR EXISTS (
      SELECT 1 FROM commerce.fulfillments f
      WHERE f.tenant_id = shipments.tenant_id
        AND f.id = shipments.fulfillment_id
        AND commerce.customer_owns_order(f.tenant_id, f.order_id)
    )
  );

CREATE POLICY customer_tracking_ownership ON commerce.tracking_events
  AS RESTRICTIVE
  USING (
    current_setting('app.role', true) IS DISTINCT FROM 'customer'
    OR EXISTS (
      SELECT 1 FROM commerce.shipments s
      JOIN commerce.fulfillments f
        ON f.tenant_id = s.tenant_id AND f.id = s.fulfillment_id
      WHERE s.tenant_id = tracking_events.tenant_id
        AND s.id = tracking_events.shipment_id
        AND commerce.customer_owns_order(f.tenant_id, f.order_id)
    )
  );

CREATE POLICY customer_ticket_ownership ON commerce.tickets
  AS RESTRICTIVE
  USING (
    current_setting('app.role', true) IS DISTINCT FROM 'customer'
    OR customer_id = nullif(current_setting('app.customer_id', true), '')::uuid
  )
  WITH CHECK (
    current_setting('app.role', true) IS DISTINCT FROM 'customer'
    OR customer_id = nullif(current_setting('app.customer_id', true), '')::uuid
  );

CREATE POLICY customer_self ON commerce.customers
  AS RESTRICTIVE
  USING (
    current_setting('app.role', true) IS DISTINCT FROM 'customer'
    OR id = nullif(current_setting('app.customer_id', true), '')::uuid
  );

GRANT USAGE ON SCHEMA commerce TO commerce_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA commerce TO commerce_runtime;
REVOKE UPDATE, DELETE ON commerce.audit_events, commerce.stock_movements, commerce.run_events FROM commerce_runtime;
REVOKE ALL ON commerce.schema_migrations FROM commerce_runtime;
GRANT SELECT ON commerce.schema_migrations TO commerce_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA commerce GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO commerce_runtime;
