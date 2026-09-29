import { Writable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { createHealthServer, createLogger } from '@commerce/telemetry';
import { describe, expect, it } from 'vitest';
import { processDiagnosticJob } from '../src/diagnostic-job.js';

function capture() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      callback();
    },
  });
  return { logger: createLogger({ service: 'worker', destination }), lines };
}

describe('diagnostic job', () => {
  it('logs the job correlation id', () => {
    const { logger, lines } = capture();
    const result = processDiagnosticJob(logger, '1', { correlation_id: 'job-corr-0001' });
    expect(result.correlation_id).toBe('job-corr-0001');
    expect(lines[0]).toMatchObject({ service: 'worker', correlation_id: 'job-corr-0001' });
  });

  it('does not trust a malformed correlation id from the payload', () => {
    const { logger, lines } = capture();
    const result = processDiagnosticJob(logger, '2', { correlation_id: 'has spaces!' });
    expect(result.correlation_id).not.toBe('has spaces!');
    expect(JSON.stringify(lines)).not.toContain('has spaces!');
  });
});

describe('health server', () => {
  it('answers readiness with 503 when a dependency is down and 404 elsewhere', async () => {
    const server = createHealthServer({
      service: 'worker',
      version: '0.0.0',
      readiness: () => Promise.resolve([{ name: 'redis', status: 'down', latency_ms: 5 }]),
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
      expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(503);
      expect((await fetch(`http://127.0.0.1:${port}/anything`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
