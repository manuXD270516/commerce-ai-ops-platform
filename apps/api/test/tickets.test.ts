import 'reflect-metadata';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AUDIENCES, generateLocalIssuerKeys, signAccessToken } from '@commerce/contracts';
import { FIXTURES, migrate, seedCommerceDomain } from '@commerce/domain';
import { createLogger } from '@commerce/telemetry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { loadConfig } from '../src/config.js';
import { DEPENDENCY_PROBE } from '../src/dependency-probe.js';
import { httpLogging } from '../src/http-logging.js';

const envFile = resolve(import.meta.dirname, '../../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const { DATABASE_ADMIN_URL, DATABASE_MIGRATOR_URL, DATABASE_URL, PII_ENCRYPTION_KEY } = process.env;
const enabled = Boolean(
  DATABASE_ADMIN_URL && DATABASE_MIGRATOR_URL && DATABASE_URL && PII_ENCRYPTION_KEY,
);

const ISSUER = 'http://127.0.0.1:3000/local-issuer';
const keys = generateLocalIssuerKeys();
const tokenFor = (subject: string, audience: (typeof AUDIENCES)['api' | 'mcp'] = AUDIENCES.api) =>
  signAccessToken(
    { subject, tenantId: FIXTURES.tenants.acme, audience },
    { issuer: ISSUER, privateJwk: keys.privateJwk },
  );

describe.skipIf(!enabled)('ticket consent over REST (M5)', () => {
  let app: NestExpressApplication;
  let baseUrl: string;

  beforeAll(async () => {
    await migrate({
      adminUrl: DATABASE_ADMIN_URL!,
      migratorUrl: DATABASE_MIGRATOR_URL!,
      runtimeUrl: DATABASE_URL!,
    });
    await seedCommerceDomain(DATABASE_MIGRATOR_URL!, PII_ENCRYPTION_KEY!);
    const config = {
      ...loadConfig({ DATABASE_URL }),
      auth: { issuer: ISSUER, jwks: keys.jwks },
    };
    const moduleRef = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
      .overrideProvider(DEPENDENCY_PROBE)
      .useValue({ check: () => Promise.resolve([]), close: () => Promise.resolve() })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    const sink = new Writable({
      write: (_c, _e, cb) => {
        cb();
      },
    });
    app.use(httpLogging(createLogger({ service: 'api', destination: sink })));
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await app.close();
  });

  const post = (
    path: string,
    body: unknown,
    bearer: string,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${bearer}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });

  it('creates a ticket only after the user records consent for that exact payload', async () => {
    const ana = tokenFor(FIXTURES.subjects.ana);
    const payload = {
      order_id: FIXTURES.orders.anaPartial,
      category: 'delivery_delay',
      summary: 'El paquete B no se mueve desde hace días',
    };
    const without = await post(
      '/v1/support-tickets',
      { ...payload, consent_id: crypto.randomUUID() },
      ana,
      {
        'idempotency-key': 'rest-ticket-0001',
      },
    );
    expect(without.status).toBe(400);
    const consentRes = await post(
      '/v1/consents',
      { command: 'create_support_ticket', payload },
      ana,
    );
    expect(consentRes.status).toBe(201);
    const consent = (await consentRes.json()) as { id: string; expires_at: string };
    const created = await post('/v1/support-tickets', { ...payload, consent_id: consent.id }, ana, {
      'idempotency-key': 'rest-ticket-0002',
    });
    expect(created.status).toBe(201);
    const ticket = (await created.json()) as { id: string; status: string };
    expect(ticket.status).toBe('OPEN');
    const retry = await post('/v1/support-tickets', { ...payload, consent_id: consent.id }, ana, {
      'idempotency-key': 'rest-ticket-0002',
    });
    expect(((await retry.json()) as { id: string }).id).toBe(ticket.id);
  });

  it('rejects MCP-audience tokens on the consent endpoint', async () => {
    const res = await post(
      '/v1/consents',
      { command: 'create_support_ticket', payload: { category: 'other', summary: 'x'.repeat(12) } },
      tokenFor(FIXTURES.subjects.ana, AUDIENCES.mcp),
    );
    expect(res.status).toBe(401);
  });
});
