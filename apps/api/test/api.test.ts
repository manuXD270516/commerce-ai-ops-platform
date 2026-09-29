import 'reflect-metadata';
import { Writable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createContractValidator, getValidator, type DependencyCheck } from '@commerce/contracts';
import { createLogger } from '@commerce/telemetry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { loadConfig } from '../src/config.js';
import { DEPENDENCY_PROBE, type DependencyProbe } from '../src/dependency-probe.js';
import { httpLogging } from '../src/http-logging.js';

const lines: Record<string, unknown>[] = [];
const destination = new Writable({
  write(chunk: Buffer, _encoding, callback) {
    lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
    callback();
  },
});

let checks: DependencyCheck[] = [];
const fakeProbe: DependencyProbe = {
  check: () => Promise.resolve(checks),
  close: () => Promise.resolve(),
};

let app: NestExpressApplication;
let baseUrl: string;
const ajv = createContractValidator();

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.forRoot(loadConfig({}))],
  })
    .overrideProvider(DEPENDENCY_PROBE)
    .useValue(fakeProbe)
    .compile();
  app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  app.use(httpLogging(createLogger({ service: 'api', destination })));
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await app.close();
});

describe('GET /v1/status', () => {
  it('echoes a valid client correlation id in body, header and request log', async () => {
    const res = await fetch(`${baseUrl}/v1/status`, {
      headers: { 'x-correlation-id': 'test-corr-0001' },
    });
    const body: unknown = await res.json();
    expect(res.status).toBe(200);
    expect(res.headers.get('x-correlation-id')).toBe('test-corr-0001');
    expect(getValidator(ajv, 'serviceStatus')(body)).toBe(true);
    expect(body).toMatchObject({ correlation_id: 'test-corr-0001' });
    const requestLog = lines.find(
      (l) => l.msg === 'request completed' && l.correlation_id === 'test-corr-0001',
    );
    expect(requestLog).toMatchObject({
      service: 'api',
      req: { method: 'GET', path: '/v1/status' },
    });
  });

  it('replaces a malformed correlation id and never logs it', async () => {
    const res = await fetch(`${baseUrl}/v1/status?email=someone@example.com`, {
      headers: { 'x-correlation-id': 'bad value' },
    });
    const generated = res.headers.get('x-correlation-id');
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(lines)).not.toContain('bad value');
    expect(JSON.stringify(lines)).not.toContain('someone@example.com');
  });
});

describe('probes', () => {
  it('reports liveness without dependency checks', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    const body: unknown = await res.json();
    expect(res.status).toBe(200);
    expect(getValidator(ajv, 'healthReport')(body)).toBe(true);
  });

  it('returns 503 when a dependency is down', async () => {
    checks = [
      { name: 'postgres', status: 'up', latency_ms: 1 },
      { name: 'pgvector', status: 'up', latency_ms: 1 },
      { name: 'redis', status: 'down', latency_ms: 2000 },
    ];
    const res = await fetch(`${baseUrl}/readyz`);
    const body: unknown = await res.json();
    expect(res.status).toBe(503);
    expect(getValidator(ajv, 'healthReport')(body)).toBe(true);
    expect(body).toMatchObject({ status: 'unavailable' });
  });

  it('returns 200 when all dependencies are up', async () => {
    checks = checks.map((c) => ({ ...c, status: 'up' as const }));
    const res = await fetch(`${baseUrl}/readyz`);
    expect(res.status).toBe(200);
  });
});
