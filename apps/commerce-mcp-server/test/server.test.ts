import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpServer } from '../src/server.js';

const server = createMcpServer('0.0.0');
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

describe('commerce-mcp-server skeleton', () => {
  it('is live and ready', async () => {
    expect((await fetch(`${baseUrl}/healthz`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/readyz`)).status).toBe(200);
  });

  it('exposes no MCP endpoint before M5', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
  });
});
