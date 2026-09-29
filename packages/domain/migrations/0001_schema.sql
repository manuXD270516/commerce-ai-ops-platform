-- Forward-only. Applied by commerce_migrator, who owns schema commerce.

CREATE TABLE commerce.tenants (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,32}$'),
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE commerce.memberships (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  subject_id text NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 128),
  role text NOT NULL CHECK (role IN ('customer', 'support', 'inventory', 'approver', 'admin')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, subject_id)
);

CREATE TABLE commerce.customers (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  subject_id text CHECK (subject_id IS NULL OR char_length(subject_id) BETWEEN 1 AND 128),
  display_name text NOT NULL,
  email_ciphertext bytea NOT NULL,
  email_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, email_hash),
  UNIQUE (tenant_id, subject_id)
);

CREATE TABLE commerce.products (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  title text NOT NULL,
  category text NOT NULL,
  description text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE commerce.skus (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL,
  sku_code text NOT NULL,
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  currency text NOT NULL CHECK (currency = 'USD'),
  brand text,
  cpu_family text,
  ram_gb integer CHECK (ram_gb IS NULL OR ram_gb > 0),
  storage_gb integer CHECK (storage_gb IS NULL OR storage_gb > 0),
  gpu text,
  weight_grams integer CHECK (weight_grams IS NULL OR weight_grams > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, sku_code),
  FOREIGN KEY (tenant_id, product_id) REFERENCES commerce.products (tenant_id, id)
);

CREATE TABLE commerce.product_attributes (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  product_id uuid,
  sku_id uuid,
  key text NOT NULL,
  value text NOT NULL,
  unit text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES commerce.products (tenant_id, id),
  FOREIGN KEY (tenant_id, sku_id) REFERENCES commerce.skus (tenant_id, id),
  CHECK ((product_id IS NOT NULL) <> (sku_id IS NOT NULL))
);

CREATE TABLE commerce.warehouses (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  region text NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE commerce.stock_balances (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  sku_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  on_hand integer NOT NULL CHECK (on_hand >= 0),
  reserved integer NOT NULL CHECK (reserved >= 0),
  safety_stock integer NOT NULL CHECK (safety_stock >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, sku_id, warehouse_id),
  CHECK (on_hand >= reserved),
  FOREIGN KEY (tenant_id, sku_id) REFERENCES commerce.skus (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES commerce.warehouses (tenant_id, id)
);

CREATE TABLE commerce.reservations (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  sku_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'RELEASED', 'CONSUMED', 'EXPIRED')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, sku_id) REFERENCES commerce.skus (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES commerce.warehouses (tenant_id, id)
);

CREATE TABLE commerce.stock_movements (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  balance_id uuid NOT NULL,
  delta_on_hand integer NOT NULL,
  delta_reserved integer NOT NULL,
  reason text NOT NULL,
  reference_id uuid NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, reference_id),
  FOREIGN KEY (tenant_id, balance_id) REFERENCES commerce.stock_balances (tenant_id, id)
);

CREATE TABLE commerce.stock_observations (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  sku_id uuid NOT NULL,
  warehouse_id uuid NOT NULL,
  counted_quantity integer NOT NULL CHECK (counted_quantity >= 0),
  observed_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('simulated', 'manual')),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, sku_id) REFERENCES commerce.skus (tenant_id, id),
  FOREIGN KEY (tenant_id, warehouse_id) REFERENCES commerce.warehouses (tenant_id, id)
);

CREATE TABLE commerce.orders (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  status text NOT NULL CHECK (
    status IN (
      'PLACED',
      'CONFIRMED',
      'FULFILLING',
      'SHIPPED',
      'DELIVERED',
      'CANCELLATION_REQUESTED'
    )
  ),
  currency text NOT NULL CHECK (currency = 'USD'),
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  tax_minor bigint NOT NULL CHECK (tax_minor >= 0),
  shipping_minor bigint NOT NULL CHECK (shipping_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CHECK (total_minor = subtotal_minor + tax_minor + shipping_minor),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES commerce.customers (tenant_id, id)
);

CREATE TABLE commerce.order_items (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  sku_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  currency text NOT NULL CHECK (currency = 'USD'),
  title_snapshot text NOT NULL,
  attributes_snapshot jsonb NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES commerce.orders (tenant_id, id),
  FOREIGN KEY (tenant_id, sku_id) REFERENCES commerce.skus (tenant_id, id)
);

ALTER TABLE commerce.reservations
  ADD CONSTRAINT reservations_order_fk
  FOREIGN KEY (tenant_id, order_id) REFERENCES commerce.orders (tenant_id, id);
ALTER TABLE commerce.reservations
  ADD CONSTRAINT reservations_order_item_fk
  FOREIGN KEY (tenant_id, order_item_id) REFERENCES commerce.order_items (tenant_id, id);

CREATE TABLE commerce.fulfillments (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN', 'PACKED', 'SHIPPED', 'DELIVERED', 'PARTIAL')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES commerce.orders (tenant_id, id)
);

CREATE TABLE commerce.fulfillment_items (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  fulfillment_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, fulfillment_id) REFERENCES commerce.fulfillments (tenant_id, id),
  FOREIGN KEY (tenant_id, order_item_id) REFERENCES commerce.order_items (tenant_id, id)
);

CREATE TABLE commerce.shipments (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  fulfillment_id uuid NOT NULL,
  carrier text NOT NULL,
  tracking_ref text NOT NULL,
  status text NOT NULL CHECK (
    status IN (
      'LABELLED',
      'IN_TRANSIT',
      'OUT_FOR_DELIVERY',
      'DELIVERED',
      'LOST',
      'DELIVERED_DISPUTED',
      'DELAYED'
    )
  ),
  estimated_delivery_at timestamptz,
  last_observed_at timestamptz NOT NULL,
  source_mode text NOT NULL CHECK (source_mode IN ('simulated')),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, fulfillment_id) REFERENCES commerce.fulfillments (tenant_id, id)
);

CREATE TABLE commerce.tracking_events (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  shipment_id uuid NOT NULL,
  carrier text NOT NULL,
  provider_event_id text NOT NULL,
  status text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, carrier, provider_event_id),
  FOREIGN KEY (tenant_id, shipment_id) REFERENCES commerce.shipments (tenant_id, id)
);

CREATE TABLE commerce.tickets (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL,
  order_id uuid,
  category text NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN', 'PENDING', 'CLOSED')),
  summary text NOT NULL,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES commerce.customers (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES commerce.orders (tenant_id, id)
);

CREATE TABLE commerce.documents (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('policy', 'faq', 'shipping', 'returns', 'product')),
  source_uri text NOT NULL,
  product_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, product_id) REFERENCES commerce.products (tenant_id, id)
);

CREATE TABLE commerce.document_versions (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL,
  checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('draft', 'published', 'retired')),
  locale text NOT NULL,
  region text NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  acl jsonb NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, document_id, version),
  FOREIGN KEY (tenant_id, document_id) REFERENCES commerce.documents (tenant_id, id)
);

CREATE TABLE commerce.chunks (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  document_version_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  body text NOT NULL,
  section text NOT NULL,
  token_count integer NOT NULL CHECK (token_count > 0),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, document_version_id, ordinal),
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES commerce.document_versions (tenant_id, id)
);

CREATE TABLE commerce.agent_runs (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  subject_id text NOT NULL,
  customer_id uuid,
  intent text,
  status text NOT NULL CHECK (
    status IN ('QUEUED', 'RUNNING', 'WAITING_HUMAN', 'COMPLETED', 'FAILED', 'CANCELLED')
  ),
  budgets jsonb NOT NULL,
  prompt_version text,
  model_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES commerce.customers (tenant_id, id)
);

CREATE TABLE commerce.run_events (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  seq integer NOT NULL CHECK (seq >= 0),
  data jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, run_id, seq),
  FOREIGN KEY (tenant_id, run_id) REFERENCES commerce.agent_runs (tenant_id, id)
);

CREATE TABLE commerce.checkpoints (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES commerce.agent_runs (tenant_id, id)
);

CREATE TABLE commerce.evidence (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL,
  kind text NOT NULL,
  resource_ref text NOT NULL,
  version text NOT NULL,
  observed_at timestamptz NOT NULL,
  document_version_id uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES commerce.agent_runs (tenant_id, id),
  FOREIGN KEY (tenant_id, document_version_id) REFERENCES commerce.document_versions (tenant_id, id)
);

CREATE TABLE commerce.action_requests (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  run_id uuid,
  requester_subject_id text NOT NULL,
  tool text NOT NULL,
  resource_id uuid NOT NULL,
  canonical_args jsonb NOT NULL,
  canonical_args_hash text NOT NULL,
  expected_version integer NOT NULL,
  policy_version text NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'STALE', 'EXECUTED', 'FAILED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES commerce.agent_runs (tenant_id, id)
);

CREATE TABLE commerce.approvals (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  action_request_id uuid NOT NULL,
  approver_subject_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
  reason text,
  decided_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, action_request_id) REFERENCES commerce.action_requests (tenant_id, id)
);

CREATE TABLE commerce.action_executions (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  action_request_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  result_ref uuid,
  status text NOT NULL CHECK (status IN ('SUCCEEDED', 'FAILED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, action_request_id),
  FOREIGN KEY (tenant_id, action_request_id) REFERENCES commerce.action_requests (tenant_id, id)
);

CREATE TABLE commerce.audit_events (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  actor_subject_id text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  outcome text NOT NULL CHECK (outcome IN ('ALLOWED', 'DENIED', 'ERROR')),
  policy_version text NOT NULL,
  correlation_id text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE commerce.outbox (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_version integer NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'published')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, event_id)
);

CREATE TABLE commerce.inbox (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  consumer text NOT NULL,
  event_id uuid NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, consumer, event_id)
);

CREATE TABLE commerce.idempotency_records (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  subject_id text NOT NULL,
  command text NOT NULL,
  idempotency_key text NOT NULL,
  payload_hash text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, subject_id, command, idempotency_key)
);

CREATE TABLE commerce.anomalies (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  sku_id uuid,
  warehouse_id uuid,
  order_id uuid,
  rule_id text NOT NULL,
  rule_version text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  evidence jsonb NOT NULL,
  window_start timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN', 'ACKED', 'INSUFFICIENT_DATA')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, rule_id, sku_id, warehouse_id, order_id, window_start)
);

CREATE INDEX orders_tenant_status_created_idx ON commerce.orders (tenant_id, status, created_at);
CREATE INDEX orders_tenant_customer_idx ON commerce.orders (tenant_id, customer_id);
CREATE INDEX skus_tenant_category_price_idx ON commerce.skus (tenant_id, currency, price_minor);
CREATE INDEX products_tenant_category_idx ON commerce.products (tenant_id, category, status);
CREATE INDEX stock_balances_tenant_sku_wh_idx ON commerce.stock_balances (tenant_id, sku_id, warehouse_id);
CREATE INDEX tracking_tenant_shipment_occurred_idx ON commerce.tracking_events (tenant_id, shipment_id, occurred_at);
CREATE INDEX outbox_pending_idx ON commerce.outbox (tenant_id, created_at) WHERE status = 'pending';
CREATE INDEX action_requests_open_idx ON commerce.action_requests (tenant_id, created_at) WHERE status = 'PENDING';

CREATE OR REPLACE FUNCTION commerce.prevent_order_item_snapshot_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.unit_price_minor IS DISTINCT FROM OLD.unit_price_minor
     OR NEW.title_snapshot IS DISTINCT FROM OLD.title_snapshot
     OR NEW.attributes_snapshot IS DISTINCT FROM OLD.attributes_snapshot
     OR NEW.sku_id IS DISTINCT FROM OLD.sku_id
     OR NEW.quantity IS DISTINCT FROM OLD.quantity THEN
    RAISE EXCEPTION 'order item snapshots are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER order_items_immutable_snapshot
  BEFORE UPDATE ON commerce.order_items
  FOR EACH ROW EXECUTE FUNCTION commerce.prevent_order_item_snapshot_mutation();

CREATE OR REPLACE FUNCTION commerce.enforce_fulfillment_qty()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ordered integer;
  fulfilled integer;
BEGIN
  SELECT quantity INTO ordered FROM commerce.order_items
    WHERE tenant_id = NEW.tenant_id AND id = NEW.order_item_id;
  SELECT COALESCE(SUM(quantity), 0) INTO fulfilled FROM commerce.fulfillment_items
    WHERE tenant_id = NEW.tenant_id AND order_item_id = NEW.order_item_id AND id IS DISTINCT FROM NEW.id;
  IF fulfilled + NEW.quantity > ordered THEN
    RAISE EXCEPTION 'fulfillment quantity exceeds ordered' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER fulfillment_items_qty
  BEFORE INSERT OR UPDATE ON commerce.fulfillment_items
  FOR EACH ROW EXECUTE FUNCTION commerce.enforce_fulfillment_qty();
