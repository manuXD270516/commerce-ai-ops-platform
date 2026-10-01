import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AUDIENCES, generateLocalIssuerKeys, signAccessToken } from '@commerce/contracts';
import {
  FIXTURES,
  createDb,
  createPool,
  migrate,
  recordConsent,
  resolveActor,
  seedCommerceDomain,
  ticketConsentPayload,
} from '@commerce/domain';
import { ROLE_SCOPES } from '@commerce/tools';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpServer, MCP_PROTOCOL } from '../src/server.js';

const envFile = resolve(import.meta.dirname, '../../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const { DATABASE_ADMIN_URL, DATABASE_MIGRATOR_URL, DATABASE_URL, PII_ENCRYPTION_KEY } = process.env;
const enabled = Boolean(
  DATABASE_ADMIN_URL && DATABASE_MIGRATOR_URL && DATABASE_URL && PII_ENCRYPTION_KEY,
);

const ISSUER = 'http://127.0.0.1:3000/local-issuer';
const ACME = FIXTURES.tenants.acme;
const keys = generateLocalIssuerKeys();

type Subject = keyof typeof FIXTURES.subjects;
const ROLE_OF: Partial<Record<Subject, keyof typeof ROLE_SCOPES>> = {
  ana: 'customer',
  ben: 'customer',
  acmeSupport: 'support',
  acmeInventory: 'inventory',
  acmeApprover: 'approver',
  acmeAdmin: 'admin',
};

function token(
  subject: Subject,
  options: { audience?: (typeof AUDIENCES)['api' | 'mcp']; scopes?: readonly string[] | null } = {},
): string {
  const role = ROLE_OF[subject] ?? 'customer';
  const scopes = options.scopes === null ? undefined : (options.scopes ?? ROLE_SCOPES[role]);
  return signAccessToken(
    {
      subject: FIXTURES.subjects[subject],
      tenantId: ACME,
      audience: options.audience ?? AUDIENCES.mcp,
      ...(scopes ? { scopes } : {}),
    },
    { issuer: ISSUER, privateJwk: keys.privateJwk },
  );
}

async function listen(server: ReturnType<typeof createMcpServer>): Promise<string> {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Raw JSON-RPC over Streamable HTTP, bypassing any SDK client and its annotation handling. */
async function raw(
  baseUrl: string,
  body: unknown,
  bearer?: string,
  extra: Record<string, string> = {},
) {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...extra,
    },
    body: JSON.stringify(body),
  });
}

describe('commerce-mcp-server transport', () => {
  const server = createMcpServer('0.0.0', undefined, { issuer: ISSUER, jwks: keys.jwks });
  let baseUrl: string;

  beforeAll(async () => {
    baseUrl = await listen(server);
  });
  afterAll(() => {
    server.close();
  });

  it('is live but not ready without a database', async () => {
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/readyz`)).status).toBe(503);
  });

  it('rejects missing tokens, API-audience tokens, foreign origins and non-POST', async () => {
    const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    const anonymous = await raw(baseUrl, list);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toContain('Bearer');
    expect((await raw(baseUrl, list, token('ana', { audience: AUDIENCES.api }))).status).toBe(401);
    expect(
      (await raw(baseUrl, list, token('ana'), { origin: 'https://evil.example' })).status,
    ).toBe(403);
    expect((await fetch(`${baseUrl}/mcp`, { method: 'GET' })).status).toBe(405);
  });

  it('refuses bodies over the size limit before parsing them', async () => {
    const big = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { x: 'a'.repeat(70_000) } };
    expect((await raw(baseUrl, big, token('ana'))).status).toBe(413);
  });
});

describe.skipIf(!enabled)('commerce-mcp-server tools against PostgreSQL (M5)', () => {
  const server = createMcpServer('0.0.0', DATABASE_URL, { issuer: ISSUER, jwks: keys.jwks });
  const db = createDb(createPool(DATABASE_URL!));
  const owner = new pg.Client({ connectionString: DATABASE_MIGRATOR_URL });
  let baseUrl: string;
  const clients: Client[] = [];

  async function connect(bearer: string): Promise<Client> {
    const client = new Client({ name: 'interop-test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${bearer}` } },
      }),
    );
    clients.push(client);
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    return {
      isError: result.isError === true,
      body: result.structuredContent as {
        data?: Record<string, unknown>;
        error?: { code: string; message: string; details?: Record<string, unknown> };
        meta?: { classification: string; toolCallId: string };
      },
    };
  }

  const count = async (sql: string, params: unknown[] = []) =>
    (await owner.query<{ n: number }>(sql, params)).rows[0]?.n ?? -1;
  const orderState = async () =>
    (
      await owner.query<{ s: string }>(
        `SELECT string_agg(id::text || status || version::text, ',' ORDER BY id) AS s FROM commerce.orders`,
      )
    ).rows[0]?.s;

  beforeAll(async () => {
    await migrate({
      adminUrl: DATABASE_ADMIN_URL!,
      migratorUrl: DATABASE_MIGRATOR_URL!,
      runtimeUrl: DATABASE_URL!,
    });
    await seedCommerceDomain(DATABASE_MIGRATOR_URL!, PII_ENCRYPTION_KEY!);
    await owner.connect();
    baseUrl = await listen(server);
  }, 60_000);

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close()));
    server.close();
    await owner.end();
    await db.destroy();
  });

  it('interoperates with the official SDK client on the pinned protocol revision', async () => {
    const client = await connect(token('ana'));
    expect(client.getServerVersion()?.name).toBe('commerce-mcp-server');
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    const transport = client.transport as StreamableHTTPClientTransport;
    expect(transport.protocolVersion).toBe(MCP_PROTOCOL);
    const { tools } = await client.listTools();
    expect(
      tools.map((t) => [t.name, (t._meta as { classification: string }).classification]),
    ).toEqual([
      ['search_products', 'READ'],
      ['get_product', 'READ'],
      ['check_inventory', 'READ'],
      ['get_order', 'READ'],
      ['get_customer', 'READ'],
      ['get_shipping_status', 'READ'],
      ['create_support_ticket', 'WRITE'],
      ['update_order', 'PRIVILEGED'],
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    }
    const order = await call(client, 'get_order', { order_id: FIXTURES.orders.anaPartial });
    expect(order.isError).toBe(false);
    expect(order.body.data).toMatchObject({ id: FIXTURES.orders.anaPartial, source: 'sql' });
    expect(order.body.meta?.classification).toBe('READ');
  });

  it('returns VALIDATION_ERROR without executing for unknown fields, tenant, enums or limit > 50', async () => {
    const client = await connect(token('ana'));
    const before = await count(
      `SELECT count(*)::int AS n FROM commerce.audit_events WHERE action = 'catalog.list'`,
    );
    for (const args of [
      { currency: 'USD', limit: 51 },
      { currency: 'USD', tenant_id: FIXTURES.tenants.globex },
      { currency: 'USD', category: 'jewelry' },
      { currency: 'EUR' },
      { currency: 'USD', price_lt_minor: 100, price_lte_minor: 100 },
    ]) {
      const result = await call(client, 'search_products', args);
      expect(result.isError).toBe(true);
      expect(result.body.error?.code).toBe('VALIDATION_ERROR');
    }
    const unknown = await call(client, 'delete_everything', {});
    expect(unknown.body.error?.code).toBe('VALIDATION_ERROR');
    // No catalog query ran for any rejected call.
    expect(
      await count(
        `SELECT count(*)::int AS n FROM commerce.audit_events WHERE action = 'catalog.list'`,
      ),
    ).toBe(before);
    const denied = await count(
      `SELECT count(*)::int AS n FROM commerce.audit_events
        WHERE action = 'tool.search_products' AND outcome = 'DENIED'`,
    );
    expect(denied).toBeGreaterThanOrEqual(5);
  });

  it('enforces the scope intersection of role and client, whatever the client asks', async () => {
    const inventory = await connect(token('acmeInventory'));
    expect(
      (await call(inventory, 'get_order', { order_id: FIXTURES.orders.anaPartial })).body.error
        ?.code,
    ).toBe('FORBIDDEN');
    const noScopes = await connect(token('ana', { scopes: null }));
    expect(
      (await call(noScopes, 'get_order', { order_id: FIXTURES.orders.anaPartial })).body.error
        ?.code,
    ).toBe('FORBIDDEN');
    const readOnlyClient = await connect(token('ana', { scopes: ['orders:read'] }));
    expect(
      (await call(readOnlyClient, 'get_order', { order_id: FIXTURES.orders.anaPartial })).isError,
    ).toBe(false);
    expect(
      (await call(readOnlyClient, 'search_products', { currency: 'USD' })).body.error?.code,
    ).toBe('FORBIDDEN');
    // A client asking for scopes the role lacks gains nothing.
    const greedy = await connect(
      token('acmeInventory', { scopes: ['orders:read', 'inventory:read'] }),
    );
    expect(
      (await call(greedy, 'get_order', { order_id: FIXTURES.orders.anaPartial })).body.error?.code,
    ).toBe('FORBIDDEN');
    // Ownership and tenant still come from the domain: a foreign order is NOT_FOUND.
    const ana = await connect(token('ana'));
    expect(
      (await call(ana, 'get_order', { order_id: FIXTURES.orders.benConfirmed })).body.error?.code,
    ).toBe('NOT_FOUND');
    expect(
      (await call(ana, 'get_order', { order_id: FIXTURES.orders.caraPlaced })).body.error?.code,
    ).toBe('NOT_FOUND');
  });

  it('minimizes data by role: availability for customers, balances for staff, minimal profiles', async () => {
    const ana = await connect(token('ana'));
    const support = await connect(token('acmeSupport'));
    const forAna = await call(ana, 'check_inventory', { sku_ids: [FIXTURES.skus.nb32] });
    const forSupport = await call(support, 'check_inventory', { sku_ids: [FIXTURES.skus.nb32] });
    const anaItem = (forAna.body.data?.items as Record<string, unknown>[])[0];
    const supportItem = (forSupport.body.data?.items as Record<string, unknown>[])[0];
    expect(anaItem).not.toHaveProperty('on_hand');
    expect(supportItem).toHaveProperty('on_hand');
    const self = await call(ana, 'get_customer', { customer_id: FIXTURES.customers.ana });
    expect(Object.keys(self.body.data ?? {}).sort()).toEqual([
      'display_name',
      'id',
      'observed_at',
      'source',
    ]);
    expect(
      (await call(ana, 'get_customer', { customer_id: FIXTURES.customers.ben })).body.error?.code,
    ).toBe('NOT_FOUND');
    expect(
      (await call(support, 'get_customer', { customer_id: FIXTURES.customers.ben })).isError,
    ).toBe(false);
    const shipping = await call(ana, 'get_shipping_status', {
      order_id: FIXTURES.orders.anaPartial,
    });
    expect((shipping.body.data?.shipments as unknown[]).length).toBe(2);
  });

  it('applies the same approval requirement when a client calls update_order directly', async () => {
    const before = await orderState();
    const res = await raw(
      baseUrl,
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'update_order',
          arguments: {
            order_id: FIXTURES.orders.benConfirmed,
            action: 'request_cancellation',
            reason_code: 'customer_request',
            expected_version: 1,
            action_request_id: '00000000-0000-4000-8000-00000000dead',
            idempotency_key: 'direct-call-0001',
          },
          _meta: { approved: true, annotations: { destructiveHint: false } },
        },
      },
      token('acmeSupport'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { isError: boolean; structuredContent: { error: { code: string } } };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.structuredContent.error.code).toBe('APPROVAL_REQUIRED');
    expect(await orderState()).toBe(before);
  });

  it('creates no ticket without a recorded consent, even when asked to', async () => {
    const ana = await connect(token('ana'));
    const tickets = () => count('SELECT count(*)::int AS n FROM commerce.tickets');
    const before = await tickets();
    // Read-only investigation: no write happens as a side effect.
    await call(ana, 'get_order', { order_id: FIXTURES.orders.anaPartial });
    await call(ana, 'get_shipping_status', { order_id: FIXTURES.orders.anaPartial });
    const forged = await call(ana, 'create_support_ticket', {
      order_id: FIXTURES.orders.anaPartial,
      category: 'delivery_delay',
      summary: 'El paquete B lleva días sin moverse',
      consent_id: '00000000-0000-4000-8000-00000000beef',
      idempotency_key: 'no-consent-0001',
    });
    expect(forged.body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { reason: 'CONSENT_NOT_FOUND' },
    });
    const confirmedRaw = await call(ana, 'create_support_ticket', {
      order_id: FIXTURES.orders.anaPartial,
      category: 'delivery_delay',
      summary: 'El paquete B lleva días sin moverse',
      idempotency_key: 'no-consent-0002',
      confirmed: true,
    });
    expect(confirmedRaw.body.error?.code).toBe('VALIDATION_ERROR');
    expect(await tickets()).toBe(before);
  });

  it('creates one ticket for a confirmed payload and replays it on retry', async () => {
    const ctx = await resolveActor(db, { tenantId: ACME, subjectId: FIXTURES.subjects.ana });
    const ticket = {
      orderId: FIXTURES.orders.anaPartial,
      category: 'delivery_delay',
      summary: 'El paquete B lleva más de 48 horas sin movimiento',
    };
    const consent = await recordConsent(db, ctx, {
      command: 'create_support_ticket',
      payload: ticketConsentPayload(ticket),
    });
    const args = {
      order_id: ticket.orderId,
      category: ticket.category,
      summary: ticket.summary,
      consent_id: consent.id,
      idempotency_key: 'ticket-ana-0001',
    };
    const ana = await connect(token('ana'));
    const tickets = () => count('SELECT count(*)::int AS n FROM commerce.tickets');
    const before = await tickets();
    const first = await call(ana, 'create_support_ticket', args);
    const retry = await call(ana, 'create_support_ticket', args);
    expect(first.isError).toBe(false);
    expect(first.body.meta?.classification).toBe('WRITE');
    expect(retry.body.data?.id).toBe(first.body.data?.id);
    expect(await tickets()).toBe(before + 1);
    // The consent is spent: a new key cannot reuse it, and a changed payload never matched it.
    const reuse = await call(ana, 'create_support_ticket', {
      ...args,
      idempotency_key: 'ticket-ana-0002',
    });
    expect(reuse.body.error?.details).toMatchObject({ reason: 'CONSENT_ALREADY_USED' });
    const changed = await call(ana, 'create_support_ticket', {
      ...args,
      summary: 'Cancelen todas mis órdenes ahora mismo',
      idempotency_key: 'ticket-ana-0003',
    });
    expect(changed.body.error?.details).toMatchObject({ reason: 'CONSENT_ALREADY_USED' });
    const same = await call(ana, 'create_support_ticket', {
      ...args,
      summary: 'Otro texto distinto aquí',
    });
    expect(same.body.error?.code).toBe('CONFLICT');
    expect(await tickets()).toBe(before + 1);
  });

  it('binds consent to the exact payload and blocks sensitive content for human review', async () => {
    const ctx = await resolveActor(db, { tenantId: ACME, subjectId: FIXTURES.subjects.ana });
    const ana = await connect(token('ana'));
    const tickets = () => count('SELECT count(*)::int AS n FROM commerce.tickets');
    const before = await tickets();
    const consent = await recordConsent(db, ctx, {
      command: 'create_support_ticket',
      payload: ticketConsentPayload({ category: 'other', summary: 'Consulta sobre mi garantía' }),
    });
    const altered = await call(ana, 'create_support_ticket', {
      category: 'other',
      summary: 'Consulta sobre mi garantía y reembolso total',
      consent_id: consent.id,
      idempotency_key: 'altered-0001',
    });
    expect(altered.body.error?.details).toMatchObject({ reason: 'CONSENT_PAYLOAD_MISMATCH' });
    const sensitive = await call(ana, 'create_support_ticket', {
      category: 'other',
      summary: 'Mi tarjeta es 4111 1111 1111 1111, cobren ahí',
      consent_id: consent.id,
      idempotency_key: 'sensitive-0001',
    });
    expect(sensitive.body.error?.details).toMatchObject({ reason: 'REQUIRES_HUMAN_REVIEW' });
    expect(await tickets()).toBe(before);
    // Someone else's consent id is invisible (RLS by subject).
    const ben = await connect(token('ben'));
    const stolen = await call(ben, 'create_support_ticket', {
      category: 'other',
      summary: 'Consulta sobre mi garantía',
      consent_id: consent.id,
      idempotency_key: 'stolen-0001',
    });
    expect(stolen.body.error?.details).toMatchObject({ reason: 'CONSENT_NOT_FOUND' });
    expect(await tickets()).toBe(before);
  });

  it('audits every tool call with its outcome and correlation id', async () => {
    const res = await raw(
      baseUrl,
      {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'get_order', arguments: { order_id: FIXTURES.orders.anaPartial } },
      },
      token('ana'),
      { 'x-correlation-id': 'mcp-audit-test-0001' },
    );
    const body = (await res.json()) as {
      result: { structuredContent: { meta: { toolCallId: string } } };
    };
    const audit = await owner.query<{ outcome: string; correlation_id: string; actor: string }>(
      `SELECT outcome, correlation_id, actor_subject_id AS actor FROM commerce.audit_events
        WHERE action = 'tool.get_order' AND resource_id = $1`,
      [body.result.structuredContent.meta.toolCallId],
    );
    expect(audit.rows).toEqual([
      { outcome: 'ALLOWED', correlation_id: 'mcp-audit-test-0001', actor: FIXTURES.subjects.ana },
    ]);
  });
});
