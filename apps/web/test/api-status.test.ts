import { describe, expect, it } from 'vitest';
import { checkApiStatus, type WebStatusBody } from '../lib/api-status';

const apiBaseUrl = 'http://api.test';

function fakeApi(body: unknown, status = 200) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) => {
    calls.push({ url, headers: init?.headers as Record<string, string> });
    return Promise.resolve(Response.json(body, { status }));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('checkApiStatus', () => {
  it('forwards the correlation id and returns the validated API status', async () => {
    const api = {
      service: 'api',
      version: '0.0.0',
      status: 'ok',
      correlation_id: 'web-corr-0001',
      observed_at: '2026-09-29T05:00:00.000Z',
    };
    const { fetchImpl, calls } = fakeApi(api);
    const req = new Request('http://web.test/api/status', {
      headers: { 'x-correlation-id': 'web-corr-0001' },
    });
    const res = await checkApiStatus(req, { apiBaseUrl, fetchImpl });
    const body = (await res.json()) as WebStatusBody;
    expect(res.status).toBe(200);
    expect(res.headers.get('x-correlation-id')).toBe('web-corr-0001');
    expect(calls[0]?.url).toBe('http://api.test/v1/status');
    expect(calls[0]?.headers['x-correlation-id']).toBe('web-corr-0001');
    expect(body).toEqual({ service: 'web', correlation_id: 'web-corr-0001', status: 'ok', api });
  });

  it('degrades with 502 when the API violates its contract', async () => {
    const { fetchImpl } = fakeApi({ service: 'api', unexpected: true });
    const res = await checkApiStatus(new Request('http://web.test/api/status'), {
      apiBaseUrl,
      fetchImpl,
    });
    expect(res.status).toBe(502);
    expect(((await res.json()) as WebStatusBody).status).toBe('degraded');
  });

  it('degrades with 502 when the API is unreachable', async () => {
    const fetchImpl = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch;
    const res = await checkApiStatus(new Request('http://web.test/api/status'), {
      apiBaseUrl,
      fetchImpl,
    });
    expect(res.status).toBe(502);
  });
});
