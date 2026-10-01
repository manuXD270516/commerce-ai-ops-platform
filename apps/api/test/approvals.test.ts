import 'reflect-metadata';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AUDIENCES, generateLocalIssuerKeys, signAccessToken } from '@commerce/contracts';
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
const tokenFor = (subject: string, audience: (typeof AUDIENCES)['api' | 'mcp'] = AUDIENCES.api) =>
  signAccessToken(
    { subject, tenantId: FIXTURES.tenants.acme, audience },
    { issuer: ISSUER, privateJwk: keys.privateJwk },
  );

describe.skipIf(!enabled)('approval inbox and resumed runs over REST (M8)', () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  const owner = new pg.Client({ connectionString: DATABASE_MIGRATOR_URL });
  const ben = tokenFor(FIXTURES.subjects.ben);
  const approver = tokenFor(FIXTURES.subjects.acmeApprover);

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

  const call = (
    method: string,
    path: string,
    bearer: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  async function waitStatus(id: string, wanted: string[]) {
    for (let i = 0; i < 100; i++) {
      const run = (await (await call('GET', `/v1/agent-runs/${id}`, ben)).json()) as {
        status: string;
        outcome: string | null;
      };
      if (wanted.includes(run.status)) return run;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('timeout');
  }

  it('runs the cancellation case end to end: proposal, user confirmation, approval, single effect', async () => {
    const orderId = FIXTURES.orders.benConfirmed;
    const run = (await (
      await call('POST', '/v1/agent-runs', ben, {
        message: `Quiero solicitar la cancelación del pedido ${orderId}`,
      })
    ).json()) as { id: string };
    expect(await waitStatus(run.id, ['WAITING_HUMAN'])).toMatchObject({ status: 'WAITING_HUMAN' });

    // The model's own claim of approval or a self-approval never counts.
    const created = await call(
      'POST',
      '/v1/action-requests',
      ben,
      { order_id: orderId, reason_code: 'customer_request', expected_version: 1, run_id: run.id },
      { 'idempotency-key': `confirm-${run.id}` },
    );
    expect(created.status).toBe(201);
    const request = (await created.json()) as { id: string; effect: string; expires_at: string };
    expect(request.effect).toContain('CANCELLATION_REQUESTED');
    expect(
      (await call('POST', `/v1/approvals/${request.id}/decision`, ben, { decision: 'APPROVED' }))
        .status,
    ).toBe(403);
    expect(
      (
        await call(
          'POST',
          `/v1/approvals/${request.id}/decision`,
          tokenFor(FIXTURES.subjects.acmeApprover, AUDIENCES.mcp),
          { decision: 'APPROVED' },
        )
      ).status,
    ).toBe(401);

    const inbox = (await (
      await call('GET', '/v1/action-requests?status=PENDING', approver)
    ).json()) as {
      items: {
        id: string;
        canonical_args: unknown;
        expected_version: number;
        current_order: unknown;
        stale: boolean;
      }[];
    };
    expect(inbox.items.find((i) => i.id === request.id)).toMatchObject({
      canonical_args: {
        order_id: orderId,
        action: 'request_cancellation',
        reason_code: 'customer_request',
        expected_version: 1,
      },
      expected_version: 1,
      current_order: { status: 'CONFIRMED', version: 1 },
      stale: false,
    });
    const decided = await call('POST', `/v1/approvals/${request.id}/decision`, approver, {
      decision: 'APPROVED',
    });
    expect(decided.status).toBe(201);
    const done = await waitStatus(run.id, ['COMPLETED', 'FAILED']);
    expect(done).toMatchObject({ status: 'COMPLETED', outcome: 'ACTION_EXECUTED' });
    const events = await (await call('GET', `/v1/agent-runs/${run.id}/events`, ben)).text();
    expect(events).toContain('Cancelación solicitada');
    expect(events).not.toMatch(/pedido cancelado|orden cancelada/i);
    const order = (
      await owner.query<{ status: string; version: number }>(
        'SELECT status, version FROM commerce.orders WHERE id = $1',
        [orderId],
      )
    ).rows[0];
    expect(order).toEqual({ status: 'CANCELLATION_REQUESTED', version: 2 });
    const executions = await owner.query(
      'SELECT 1 FROM commerce.action_executions WHERE action_request_id = $1',
      [request.id],
    );
    expect(executions.rowCount).toBe(1);

    // A reviewer reconstructs the action from persisted evidence alone.
    const trail = (await (
      await call('GET', `/v1/action-requests/${request.id}/trail`, approver)
    ).json()) as {
      request: { requester: string; policy_version: string; expected_version: number };
      approval: { approverSubjectId: string; decision: string };
      execution: { idempotencyKey: string; status: string };
      audit: {
        action: string;
        actor: string;
        correlationId: string | null;
        policyVersion: string;
      }[];
      events: { payload: { status: string } }[];
    };
    expect(trail.request).toMatchObject({
      requester: FIXTURES.subjects.ben,
      policy_version: 'policy.v1',
      expected_version: 1,
    });
    expect(trail.approval).toMatchObject({
      approverSubjectId: FIXTURES.subjects.acmeApprover,
      decision: 'APPROVED',
    });
    expect(trail.execution).toMatchObject({ idempotencyKey: `run-${run.id}`, status: 'SUCCEEDED' });
    const actions = trail.audit.map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'action_requests.create',
        'approvals.approve',
        'orders.update_order',
        'approvals.consume',
      ]),
    );
    expect(trail.audit.find((a) => a.action === 'orders.update_order')?.correlationId).toBe(
      `run-${run.id}`,
    );
    expect(trail.events.map((e) => e.payload.status)).toEqual(['CANCELLATION_REQUESTED']);
    expect((await call('GET', `/v1/action-requests/${request.id}/trail`, ben)).status).toBe(403);
  });

  it('reports a stale approval as a server conflict and never as executed', async () => {
    const orderId = crypto.randomUUID();
    await owner.query(
      `INSERT INTO commerce.orders (tenant_id, id, customer_id, status, currency, subtotal_minor, tax_minor, shipping_minor, total_minor)
       VALUES ($1, $2, $3, 'CONFIRMED', 'USD', 2900, 0, 0, 2900)`,
      [FIXTURES.tenants.acme, orderId, FIXTURES.customers.ben],
    );
    const created = (await (
      await call(
        'POST',
        '/v1/action-requests',
        ben,
        { order_id: orderId, reason_code: 'customer_request', expected_version: 1 },
        { 'idempotency-key': `stale-${orderId}` },
      )
    ).json()) as { id: string };
    await owner.query('UPDATE commerce.orders SET version = 2 WHERE id = $1', [orderId]);
    const view = (await (
      await call('GET', `/v1/action-requests/${created.id}`, approver)
    ).json()) as { stale: boolean };
    expect(view.stale).toBe(true);
    // The approver acts on a screen opened before the change: the server answers with a conflict.
    const decision = await call('POST', `/v1/approvals/${created.id}/decision`, approver, {
      decision: 'APPROVED',
    });
    expect(decision.status).toBe(409);
    expect(((await decision.json()) as { code: string }).code).toBe('CONFLICT');
    const exec = await call(
      'POST',
      `/v1/orders/${orderId}/actions`,
      ben,
      {
        action: 'request_cancellation',
        reason_code: 'customer_request',
        expected_version: 1,
        action_request_id: created.id,
      },
      { 'idempotency-key': `exec-${orderId}` },
    );
    expect(exec.status).toBe(409);
    expect(((await exec.json()) as { code: string }).code).toBe('APPROVAL_REQUIRED');
    const after = (await (await call('GET', `/v1/action-requests/${created.id}`, ben)).json()) as {
      status: string;
    };
    expect(after.status).toBe('STALE');
  });
});
