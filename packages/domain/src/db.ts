import { type ColumnType, type Generated, Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

type Json = ColumnType<unknown, unknown, unknown>;

export interface TenantsTable {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  created_at: Generated<Date>;
}

export interface MembershipsTable {
  tenant_id: string;
  id: string;
  subject_id: string;
  role: string;
  enabled: boolean;
  created_at: Generated<Date>;
}

export interface CustomersTable {
  tenant_id: string;
  id: string;
  subject_id: string | null;
  display_name: string;
  email_ciphertext: Buffer;
  email_hash: Buffer;
  created_at: Generated<Date>;
}

export interface ProductsTable {
  tenant_id: string;
  id: string;
  title: string;
  category: string;
  description: string;
  status: string;
  created_at: Generated<Date>;
  updated_at: Date;
}

export interface SkusTable {
  tenant_id: string;
  id: string;
  product_id: string;
  sku_code: string;
  price_minor: string;
  currency: string;
  brand: string | null;
  cpu_family: string | null;
  ram_gb: number | null;
  storage_gb: number | null;
  gpu: string | null;
  weight_grams: number | null;
  version: number;
}

export interface WarehousesTable {
  tenant_id: string;
  id: string;
  name: string;
  region: string;
}

export interface StockBalancesTable {
  tenant_id: string;
  id: string;
  sku_id: string;
  warehouse_id: string;
  on_hand: number;
  reserved: number;
  safety_stock: number;
  version: number;
}

export interface ReservationsTable {
  tenant_id: string;
  id: string;
  order_id: string;
  order_item_id: string;
  sku_id: string;
  warehouse_id: string;
  quantity: number;
  status: string;
  expires_at: Date;
  created_at: Generated<Date>;
}

export interface StockMovementsTable {
  tenant_id: string;
  id: string;
  balance_id: string;
  delta_on_hand: number;
  delta_reserved: number;
  reason: string;
  reference_id: string;
  recorded_at: Generated<Date>;
}

export interface StockObservationsTable {
  tenant_id: string;
  id: string;
  sku_id: string;
  warehouse_id: string;
  counted_quantity: number;
  observed_at: Date;
  source: string;
}

export interface OrdersTable {
  tenant_id: string;
  id: string;
  customer_id: string;
  status: string;
  currency: string;
  subtotal_minor: string;
  tax_minor: string;
  shipping_minor: string;
  total_minor: string;
  version: number;
  created_at: Generated<Date>;
  updated_at: Date;
}

export interface OrderItemsTable {
  tenant_id: string;
  id: string;
  order_id: string;
  sku_id: string;
  quantity: number;
  unit_price_minor: string;
  currency: string;
  title_snapshot: string;
  attributes_snapshot: unknown;
}

export interface FulfillmentsTable {
  tenant_id: string;
  id: string;
  order_id: string;
  status: string;
  created_at: Generated<Date>;
}

export interface FulfillmentItemsTable {
  tenant_id: string;
  id: string;
  fulfillment_id: string;
  order_item_id: string;
  quantity: number;
}

export interface ShipmentsTable {
  tenant_id: string;
  id: string;
  fulfillment_id: string;
  carrier: string;
  tracking_ref: string;
  status: string;
  estimated_delivery_at: Date | null;
  last_observed_at: Date;
  source_mode: string;
}

export interface TrackingEventsTable {
  tenant_id: string;
  id: string;
  shipment_id: string;
  carrier: string;
  provider_event_id: string;
  status: string;
  occurred_at: Date;
  received_at: Generated<Date>;
}

export interface TicketsTable {
  tenant_id: string;
  id: string;
  customer_id: string;
  order_id: string | null;
  category: string;
  status: string;
  summary: string;
  evidence_refs: Json;
  created_by: string;
  created_at: Generated<Date>;
}

export interface DocumentsTable {
  tenant_id: string;
  id: string;
  kind: string;
  source_uri: string;
  product_id: string | null;
  created_at: Generated<Date>;
}

export interface DocumentVersionsTable {
  tenant_id: string;
  id: string;
  document_id: string;
  checksum: string;
  version: number;
  status: string;
  locale: string;
  region: string;
  valid_from: Date;
  valid_to: Date | null;
  acl: Json;
}

export interface ChunksTable {
  tenant_id: string;
  id: string;
  document_version_id: string;
  ordinal: number;
  body: string;
  section: string;
  token_count: number;
  embedding: string | null;
}

export interface AgentRunsTable {
  tenant_id: string;
  id: string;
  subject_id: string;
  customer_id: string | null;
  intent: string | null;
  status: string;
  budgets: Json;
  prompt_version: string | null;
  model_version: string | null;
  created_at: Generated<Date>;
}

export interface RunEventsTable {
  tenant_id: string;
  id: string;
  run_id: string;
  seq: number;
  data: Json;
  recorded_at: Generated<Date>;
}

export interface CheckpointsTable {
  tenant_id: string;
  id: string;
  run_id: string;
  payload: Json;
  recorded_at: Generated<Date>;
}

export interface EvidenceTable {
  tenant_id: string;
  id: string;
  run_id: string;
  kind: string;
  resource_ref: string;
  version: string;
  observed_at: Date;
  document_version_id: string | null;
}

export interface ActionRequestsTable {
  tenant_id: string;
  id: string;
  run_id: string | null;
  requester_subject_id: string;
  tool: string;
  resource_id: string;
  canonical_args: Json;
  canonical_args_hash: string;
  expected_version: number;
  policy_version: string;
  expires_at: Date;
  status: string;
  created_at: Generated<Date>;
}

export interface ApprovalsTable {
  tenant_id: string;
  id: string;
  action_request_id: string;
  approver_subject_id: string;
  decision: string;
  reason: string | null;
  decided_at: Generated<Date>;
  expires_at: Date;
}

export interface ActionExecutionsTable {
  tenant_id: string;
  id: string;
  action_request_id: string;
  idempotency_key: string;
  result_ref: string | null;
  status: string;
  created_at: Generated<Date>;
}

export interface AuditEventsTable {
  tenant_id: string;
  id: string;
  actor_subject_id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: string;
  policy_version: string;
  correlation_id: string | null;
  recorded_at: Generated<Date>;
}

export interface OutboxTable {
  tenant_id: string;
  id: string;
  event_id: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  payload: Json;
  status: string;
  created_at: Generated<Date>;
}

export interface InboxTable {
  tenant_id: string;
  id: string;
  consumer: string;
  event_id: string;
  processed_at: Generated<Date>;
}

export interface IdempotencyRecordsTable {
  tenant_id: string;
  id: string;
  subject_id: string;
  command: string;
  idempotency_key: string;
  payload_hash: string;
  response: Json;
  created_at: Generated<Date>;
}

export interface AnomaliesTable {
  tenant_id: string;
  id: string;
  sku_id: string | null;
  warehouse_id: string | null;
  order_id: string | null;
  rule_id: string;
  rule_version: string;
  severity: string;
  evidence: Json;
  window_start: Date;
  status: string;
  created_at: Generated<Date>;
}

export interface RetrievalCacheTable {
  tenant_id: string;
  cache_key: string;
  payload: Json;
  corpus_version: string;
  expires_at: Date;
}

export interface Database {
  tenants: TenantsTable;
  memberships: MembershipsTable;
  customers: CustomersTable;
  products: ProductsTable;
  skus: SkusTable;
  warehouses: WarehousesTable;
  stock_balances: StockBalancesTable;
  reservations: ReservationsTable;
  stock_movements: StockMovementsTable;
  stock_observations: StockObservationsTable;
  orders: OrdersTable;
  order_items: OrderItemsTable;
  fulfillments: FulfillmentsTable;
  fulfillment_items: FulfillmentItemsTable;
  shipments: ShipmentsTable;
  tracking_events: TrackingEventsTable;
  tickets: TicketsTable;
  documents: DocumentsTable;
  document_versions: DocumentVersionsTable;
  chunks: ChunksTable;
  agent_runs: AgentRunsTable;
  run_events: RunEventsTable;
  checkpoints: CheckpointsTable;
  evidence: EvidenceTable;
  action_requests: ActionRequestsTable;
  approvals: ApprovalsTable;
  action_executions: ActionExecutionsTable;
  audit_events: AuditEventsTable;
  outbox: OutboxTable;
  inbox: InboxTable;
  idempotency_records: IdempotencyRecordsTable;
  anomalies: AnomaliesTable;
  retrieval_cache: RetrievalCacheTable;
}

export type DomainDb = Kysely<Database>;

export function createPool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({ connectionString, max: 8 });
  pool.on('error', () => undefined);
  return pool;
}

export function createDb(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  }).withSchema('commerce');
}
