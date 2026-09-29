import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpServer, MCP_PROTOCOL } from '../src/server.js';

const server = createMcpServer('0.0.0');
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

async function mcp(
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

describe('commerce-mcp-server', () => {
  it('is live but not ready without a database', async () => {
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/readyz`)).status).toBe(503);
  });

  it('rejects unauthenticated MCP calls', async () => {
    const res = await mcp('tools/list');
    expect(res.status).toBe(401);
  });

  it('lists eight classified tools over authenticated transport', async () => {
    const res = await mcp(
      'tools/list',
      {},
      { 'x-tenant-id': '00000000-0000-4000-8000-000000000001', 'x-subject-id': 'acme-support' },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-protocol-version')).toBe(MCP_PROTOCOL);
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name)).toEqual([
      'search_products',
      'get_product',
      'check_inventory',
      'get_order',
      'get_customer',
      'get_shipping_status',
      'create_support_ticket',
      'update_order',
    ]);
  });

  it('validates unknown fields and limit > 50 without executing', async () => {
    const res = await mcp(
      'tools/call',
      { name: 'search_products', arguments: { limit: 99, tenant: 'evil' } },
      { 'x-tenant-id': '00000000-0000-4000-8000-000000000001', 'x-subject-id': 'acme-support' },
    );
    const body = (await res.json()) as { error?: { message: string } };
    expect(body.error?.message).toBe('VALIDATION_ERROR');
  });
});
