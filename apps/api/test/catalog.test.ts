import 'reflect-metadata';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  AUDIENCES,
  createContractValidator,
  generateLocalIssuerKeys,
  getValidator,
  signAccessToken,
  type Audience,
  type SchemaName,
} from '@commerce/contracts';
import { FIXTURES, migrate, seedCommerceDomain } from '@commerce/domain';
import { createLogger } from '@commerce/telemetry';
import { Writable } from 'node:stream';
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
const ajv = createContractValidator();

function tokenFor(
  subject: string,
  tenantId: string = FIXTURES.tenants.acme,
  audience: Audience = AUDIENCES.api,
) {
  return signAccessToken(
    { subject, tenantId, audience },
    { issuer: ISSUER, privateJwk: keys.privateJwk },
  );
}

describe.skipIf(!enabled)('catalog API contract (M2)', () => {
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

  async function call(path: string, token?: string) {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  function expectContract(body: unknown, schema: SchemaName) {
    const validate = getValidator(ajv, schema);
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  }

  it('answers 401 without a token, with a forged token and with an MCP-audience token', async () => {
    const other = generateLocalIssuerKeys();
    const forged = signAccessToken(
      { subject: FIXTURES.subjects.ana, tenantId: FIXTURES.tenants.acme, audience: AUDIENCES.api },
      { issuer: ISSUER, privateJwk: other.privateJwk },
    );
    for (const token of [
      undefined,
      forged,
      tokenFor(FIXTURES.subjects.ana, FIXTURES.tenants.acme, AUDIENCES.mcp),
    ]) {
      const { status, body } = await call('/v1/products', token);
      expect(status).toBe(401);
      expectContract(body, 'error');
      expect(body.code).toBe('UNAUTHENTICATED');
    }
  });

  it('ignores legacy tenant headers: a valid Acme token never reaches Globex rows', async () => {
    const res = await fetch(`${baseUrl}/v1/products?limit=50`, {
      headers: {
        authorization: `Bearer ${tokenFor(FIXTURES.subjects.ana)}`,
        'x-tenant-id': FIXTURES.tenants.globex,
      },
    });
    const body = (await res.json()) as { items: { sku_code: string }[] };
    expect(body.items.some((sku) => sku.sku_code.startsWith('GX-'))).toBe(false);
  });

  it('rejects a subject without membership in the token tenant', async () => {
    const { status, body } = await call(
      '/v1/products',
      tokenFor(FIXTURES.subjects.ana, FIXTURES.tenants.globex),
    );
    expect(status).toBe(403);
    expectContract(body, 'error');
  });

  it('applies the strict USD 1500 budget (price_minor < 150000) and matches the contract', async () => {
    const { status, body } = await call(
      '/v1/products?category=notebook&currency=USD&price_lt=150000',
      tokenFor(FIXTURES.subjects.ana),
    );
    expect(status).toBe(200);
    expectContract(body, 'productList');
    const items = body.items as { sku_code: string; price_minor: number; currency: string }[];
    expect(items.map((sku) => sku.sku_code)).toEqual(['NB-DEV-16', 'NB-DEV-32']);
    expect(items.every((sku) => sku.currency === 'USD' && sku.price_minor < 150_000)).toBe(true);
  });

  it('walks cursors deterministically with limit=1', async () => {
    const token = tokenFor(FIXTURES.subjects.ana);
    const full = await call('/v1/products?limit=50', token);
    const ids: string[] = [];
    let path = '/v1/products?limit=1';
    for (let i = 0; i < 20; i++) {
      const { body } = await call(path, token);
      expectContract(body, 'productList');
      ids.push(...(body.items as { id: string }[]).map((sku) => sku.id));
      if (typeof body.next_cursor !== 'string') break;
      path = `/v1/products?limit=1&cursor=${encodeURIComponent(body.next_cursor)}`;
    }
    expect(ids).toEqual((full.body.items as { id: string }[]).map((sku) => sku.id));
  });

  it.each([
    '/v1/products?currency=EUR',
    '/v1/products?limit=51',
    '/v1/products?limit=0',
    '/v1/products?price_lt=abc',
    '/v1/products?price_lt=1.5',
    '/v1/products?price_lt=-1',
    '/v1/products?tenant_id=00000000-0000-4000-8000-000000000002',
    '/v1/products?limit=1&limit=2',
    '/v1/products?cursor=bogus',
    '/v1/products/not-a-uuid',
    '/v1/inventory/not-a-uuid',
  ])('rejects %s with a stable VALIDATION_ERROR', async (path) => {
    const { status, body } = await call(path, tokenFor(FIXTURES.subjects.ana));
    expect(status).toBe(400);
    expectContract(body, 'error');
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('returns product detail and hides drafts and other tenants as NOT_FOUND', async () => {
    const token = tokenFor(FIXTURES.subjects.ana);
    const ok = await call(`/v1/products/${FIXTURES.products.notebook}`, token);
    expect(ok.status).toBe(200);
    expectContract(ok.body, 'productList');
    for (const id of [FIXTURES.products.draftProto, FIXTURES.products.globexNotebook]) {
      const { status, body } = await call(`/v1/products/${id}`, token);
      expect(status).toBe(404);
      expectContract(body, 'error');
    }
  });

  it('shows customers availability only and inventory staff the stock internals', async () => {
    const customer = await call(
      `/v1/inventory/${FIXTURES.skus.nb16}?region=us-east`,
      tokenFor(FIXTURES.subjects.ana),
    );
    expect(customer.status).toBe(200);
    expectContract(customer.body, 'inventory');
    expect(customer.body).toMatchObject({ available: 11, region: 'us-east' });
    expect(customer.body).not.toHaveProperty('on_hand');

    const staff = await call(
      `/v1/inventory/${FIXTURES.skus.nb16}`,
      tokenFor(FIXTURES.subjects.acmeInventory),
    );
    expectContract(staff.body, 'inventory');
    expect(staff.body).toMatchObject({ on_hand: 12, reserved: 1, safety_stock: 5 });

    const draft = await call(
      `/v1/inventory/${FIXTURES.skus.draftProto}`,
      tokenFor(FIXTURES.subjects.ana),
    );
    expect(draft.status).toBe(404);
    const otherTenant = await call(
      `/v1/inventory/${FIXTURES.skus.globexNb16}`,
      tokenFor(FIXTURES.subjects.ana),
    );
    expect(otherTenant.status).toBe(404);
  });

  it('maps unknown routes to the error contract', async () => {
    const { status, body } = await call('/v1/nope', tokenFor(FIXTURES.subjects.ana));
    expect(status).toBe(404);
    expectContract(body, 'error');
  });
});
