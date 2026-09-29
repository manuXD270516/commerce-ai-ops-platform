import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  checkInventory,
  createDb,
  createPool,
  createSupportTicket,
  DomainError,
  executeUpdateOrder,
  getCustomer,
  getOrder,
  getProduct,
  getShippingStatus,
  isDomainError,
  listCatalog,
  resolveActor,
  resolveTenantId,
  type ActorContext,
  type DomainDb,
} from '@commerce/domain';
import type { HealthReport } from '@commerce/contracts';

const TOOLS = [
  { name: 'search_products', classification: 'READ' },
  { name: 'get_product', classification: 'READ' },
  { name: 'check_inventory', classification: 'READ' },
  { name: 'get_order', classification: 'READ' },
  { name: 'get_customer', classification: 'READ' },
  { name: 'get_shipping_status', classification: 'READ' },
  { name: 'create_support_ticket', classification: 'WRITE' },
  { name: 'update_order', classification: 'PRIVILEGED' },
] as const;

export const MCP_PROTOCOL = '2025-06-18';

export function createMcpServer(version: string, databaseUrl?: string): Server {
  const pool = databaseUrl ? createPool(databaseUrl) : undefined;
  const db = pool ? createDb(pool) : undefined;
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && (path === '/healthz' || path === '/readyz')) {
      writeHealth(res, version, path === '/readyz' && !db ? 'unavailable' : 'ok');
      return;
    }
    if (path === '/mcp') {
      void handleMcp(req, res, db);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"status":"not_found"}');
  });
  server.on('close', () => {
    void db?.destroy();
  });
  return server;
}

function writeHealth(res: ServerResponse, version: string, status: HealthReport['status']): void {
  const body: HealthReport = {
    status,
    service: 'commerce-mcp-server',
    version,
    observed_at: new Date().toISOString(),
    checks: [],
  };
  res.writeHead(status === 'ok' ? 200 : 503, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  db: DomainDb | undefined,
): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  const tenant = header(req, 'x-tenant-id');
  const subject = header(req, 'x-subject-id');
  if (!tenant || !subject) {
    res.writeHead(401, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'authentication required' },
      }),
    );
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  let body: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body;
  } catch {
    res.writeHead(400).end();
    return;
  }
  try {
    const result = await dispatch(db, tenant, subject, body.method ?? '', body.params ?? {});
    res
      .writeHead(200, { 'content-type': 'application/json', 'mcp-protocol-version': MCP_PROTOCOL })
      .end(JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, result }));
  } catch (error) {
    const mapped = isDomainError(error)
      ? error
      : new DomainError('VALIDATION_ERROR', 'Invalid tool call');
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: body.id ?? 1,
        error: { code: -32000, message: mapped.code, data: { message: mapped.message } },
      }),
    );
  }
}

async function dispatch(
  db: DomainDb | undefined,
  tenant: string,
  subject: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (method === 'initialize') {
    return {
      protocolVersion: MCP_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: 'commerce-mcp-server' },
    };
  }
  if (method === 'tools/list') {
    return {
      tools: TOOLS.map((tool) => ({
        name: tool.name,
        description: `${tool.classification} tool`,
        annotations: { classification: tool.classification },
        inputSchema: { type: 'object', additionalProperties: false },
      })),
    };
  }
  if (method !== 'tools/call') throw new DomainError('VALIDATION_ERROR', 'Unknown method');
  const name = typeof params.name === 'string' ? params.name : '';
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  if ('tenant' in args || 'tenant_id' in args) {
    throw new DomainError('VALIDATION_ERROR', 'tenant may not be supplied as a tool argument');
  }
  if (typeof args.limit === 'number' && args.limit > 50) {
    throw new DomainError('VALIDATION_ERROR', 'limit > 50');
  }
  if (!db) throw new DomainError('DEPENDENCY_UNAVAILABLE', 'DATABASE_URL is not configured');
  const tenantId = await resolveTenantId(db, tenant);
  const ctx = await resolveActor(db, { tenantId, subjectId: subject });
  return { content: [{ type: 'text', text: JSON.stringify(await callTool(db, ctx, name, args)) }] };
}

async function callTool(
  db: DomainDb,
  ctx: ActorContext,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case 'search_products':
      return listCatalog(db, ctx, {
        category: asString(args.category),
        currency: asString(args.currency),
        priceLt: asNumber(args.price_lt),
        limit: asNumber(args.limit),
      });
    case 'get_product':
      return getProduct(db, ctx, requiredString(args.product_id));
    case 'check_inventory':
      return checkInventory(db, ctx, requiredString(args.sku_id), asString(args.region));
    case 'get_order':
      return getOrder(db, ctx, requiredString(args.order_id));
    case 'get_customer':
      return getCustomer(db, ctx, requiredString(args.customer_id));
    case 'get_shipping_status':
      return getShippingStatus(db, ctx, requiredString(args.order_id));
    case 'create_support_ticket':
      if (args.confirmed !== true) {
        throw new DomainError('VALIDATION_ERROR', 'WRITE requires explicit consent');
      }
      return createSupportTicket(db, ctx, {
        customerId: requiredString(args.customer_id),
        orderId: asString(args.order_id),
        category: requiredString(args.category),
        summary: requiredString(args.summary),
        confirmed: true,
        idempotencyKey: requiredString(args.idempotency_key),
      });
    case 'update_order':
      return executeUpdateOrder(db, ctx, {
        orderId: requiredString(args.order_id),
        action: 'request_cancellation',
        expectedVersion: asNumber(args.expected_version) ?? 0,
        actionRequestId: requiredString(args.action_request_id),
        idempotencyKey: requiredString(args.idempotency_key),
      });
    default:
      throw new DomainError('VALIDATION_ERROR', 'Unknown tool');
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DomainError('VALIDATION_ERROR', 'required string argument missing');
  }
  return value;
}
