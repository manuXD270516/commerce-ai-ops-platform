import 'reflect-metadata';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  AUDIENCES,
  createContractValidator,
  generateLocalIssuerKeys,
  getValidator,
  signAccessToken,
} from '@commerce/contracts';
import {
  FIXTURES,
  createDb,
  createPool,
  hashEmbedder,
  migrate,
  seedCommerceDomain,
  seedKnowledgeCorpus,
} from '@commerce/domain';
import { createLogger } from '@commerce/telemetry';
import pg from 'pg';
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
const tokenFor = (subject: string) =>
  signAccessToken(
    { subject, tenantId: FIXTURES.tenants.acme, audience: AUDIENCES.api },
    { issuer: ISSUER, privateJwk: keys.privateJwk },
  );

interface RunView {
  id: string;
  status: string;
  outcome: string | null;
}

describe.skipIf(!enabled)('agent runs over REST and SSE (M6)', () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  const owner = new pg.Client({ connectionString: DATABASE_MIGRATOR_URL });
  const ana = tokenFor(FIXTURES.subjects.ana);

  beforeAll(async () => {
    await migrate({
      adminUrl: DATABASE_ADMIN_URL!,
      migratorUrl: DATABASE_MIGRATOR_URL!,
      runtimeUrl: DATABASE_URL!,
    });
    await seedCommerceDomain(DATABASE_MIGRATOR_URL!, PII_ENCRYPTION_KEY!);
    const db = createDb(createPool(DATABASE_URL!));
    await seedKnowledgeCorpus(db, hashEmbedder());
    await db.destroy();
    await owner.connect();
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
    await owner.end();
  });

  const call = (method: string, path: string, bearer: string, body?: unknown, headers = {}) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  async function waitFor(id: string, done: (run: RunView) => boolean): Promise<RunView> {
    for (let i = 0; i < 100; i++) {
      const run = (await (await call('GET', `/v1/agent-runs/${id}`, ana)).json()) as RunView;
      if (done(run)) return run;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`run ${id} did not finish`);
  }

  function parseSse(text: string): { id: number; event: string; data: Record<string, unknown> }[] {
    return text
      .split('\n\n')
      .map((block) => {
        const id = /^id: (\d+)$/m.exec(block)?.[1];
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        return id && event && data
          ? { id: Number(id), event, data: JSON.parse(data) as Record<string, unknown> }
          : undefined;
      })
      .filter((e) => e !== undefined);
  }

  it('accepts a run with 202, executes it asynchronously and validates the contract', async () => {
    const res = await call('POST', '/v1/agent-runs', ana, {
      message: `¿Dónde está mi pedido ${FIXTURES.orders.anaPartial}?`,
    });
    expect(res.status).toBe(202);
    const created = (await res.json()) as RunView;
    expect(getValidator(ajv, 'agentRun')(created)).toBe(true);
    const done = await waitFor(created.id, (r) => r.status === 'COMPLETED');
    expect(done.outcome).toBe('ANSWERED');
    const evidence = (await (
      await call('GET', `/v1/agent-runs/${created.id}/evidence`, ana)
    ).json()) as {
      items: { kind: string }[];
    };
    expect(evidence.items.map((e) => e.kind)).toEqual(
      expect.arrayContaining(['order', 'shipment']),
    );
  });

  it('replays only missed events after a reconnection and never starts another run', async () => {
    const created = (await (
      await call('POST', '/v1/agent-runs', ana, {
        message: `Mi pedido ${FIXTURES.orders.anaPartial} está atrasado`,
      })
    ).json()) as RunView;
    await waitFor(created.id, (r) => r.status === 'COMPLETED');
    const runsBefore = (await owner.query('SELECT count(*)::int AS n FROM commerce.agent_runs'))
      .rows[0] as { n: number };
    const first = parseSse(
      await (await call('GET', `/v1/agent-runs/${created.id}/events`, ana)).text(),
    );
    expect(first.map((e) => e.event)).toEqual(expect.arrayContaining(['status', 'completed']));
    const completed = first.find((e) => e.event === 'completed');
    expect(completed?.data).toMatchObject({ outcome: 'ANSWERED' });
    expect(JSON.stringify(completed?.data)).not.toMatch(/chain.of.thought|razonamiento interno/i);
    const lastSeen = first[first.length - 2]?.id ?? 0;
    const resumed = parseSse(
      await (
        await call('GET', `/v1/agent-runs/${created.id}/events`, ana, undefined, {
          'last-event-id': String(lastSeen),
        })
      ).text(),
    );
    expect(resumed.map((e) => e.id)).toEqual(first.filter((e) => e.id > lastSeen).map((e) => e.id));
    const runsAfter = (await owner.query('SELECT count(*)::int AS n FROM commerce.agent_runs'))
      .rows[0] as { n: number };
    expect(runsAfter.n).toBe(runsBefore.n);
  });

  it('hides runs from other customers and validates input', async () => {
    const created = (await (
      await call('POST', '/v1/agent-runs', ana, { message: 'Mi orden no llega' })
    ).json()) as RunView;
    const ben = tokenFor(FIXTURES.subjects.ben);
    expect((await call('GET', `/v1/agent-runs/${created.id}`, ben)).status).toBe(404);
    expect((await call('GET', `/v1/agent-runs/${created.id}/events`, ben)).status).toBe(404);
    expect((await call('POST', '/v1/agent-runs', ana, {})).status).toBe(400);
    expect(
      (await call('POST', '/v1/agent-runs', ana, { message: 'x', ui_context: { intent: 'admin' } }))
        .status,
    ).toBe(400);
    const done = await waitFor(created.id, (r) => r.status === 'COMPLETED');
    expect(done.outcome).toBe('CLARIFICATION_REQUESTED');
    expect((await call('POST', `/v1/agent-runs/${created.id}/cancel`, ana)).status).toBe(409);
  });
});
