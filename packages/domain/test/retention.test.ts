import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURES,
  POLICY_VERSION,
  applyRetention,
  appendRunEvent,
  createAgentRun,
  createDb,
  createPool,
  migrate,
  seedCommerceDomain,
  updateAgentRun,
  type ActorContext,
} from '../src/index.js';

const adminUrl = process.env.DATABASE_ADMIN_URL;
const migratorUrl = process.env.DATABASE_MIGRATOR_URL;
const runtimeUrl = process.env.DATABASE_URL;
const piiKey = process.env.PII_ENCRYPTION_KEY;
const enabled = Boolean(adminUrl && migratorUrl && runtimeUrl && piiKey);

const ana: ActorContext = {
  tenantId: FIXTURES.tenants.acme,
  subjectId: FIXTURES.subjects.ana,
  role: 'customer',
  customerId: FIXTURES.customers.ana,
  policyVersion: POLICY_VERSION,
};

describe.skipIf(!enabled)('retention policy (M10)', () => {
  const db = createDb(createPool(runtimeUrl!));
  const owner = new pg.Client({ connectionString: migratorUrl });
  const runtime = new pg.Client({ connectionString: runtimeUrl });

  beforeAll(async () => {
    await migrate({ adminUrl: adminUrl!, migratorUrl: migratorUrl!, runtimeUrl: runtimeUrl! });
    await seedCommerceDomain(migratorUrl!, piiKey!);
    await owner.connect();
    await runtime.connect();
  }, 60_000);

  afterAll(async () => {
    await owner.end();
    await runtime.end();
    await db.destroy();
  });

  const run = async (message: string) => {
    const created = await createAgentRun(db, ana, {
      message,
      promptVersion: 'synth.v1',
      modelVersion: 'template-synth.v1',
      routerVersion: 'router.v1',
    });
    await appendRunEvent(db, ana, created.id, { type: 'completed', summary: message });
    await updateAgentRun(db, ana, created.id, { status: 'COMPLETED', outcome: 'ANSWERED' });
    return created.id;
  };

  it('erases run state and inputs after 30 days and governance records after 90, nothing newer', async () => {
    const old = await run('Mi email es ana@example.com y mi pedido no llega');
    const recent = await run('Consulta reciente');
    await owner.query(
      `UPDATE commerce.agent_runs SET updated_at = now() - interval '40 days' WHERE id = $1`,
      [old],
    );
    const oldAudit = randomUUID();
    await owner.query(
      `INSERT INTO commerce.audit_events (tenant_id, id, actor_subject_id, action, resource_type, outcome, policy_version, recorded_at)
       VALUES ($1, $2, 'acme-support', 'orders.read', 'order', 'ALLOWED', 'policy.v1', now() - interval '100 days')`,
      [FIXTURES.tenants.acme, oldAudit],
    );
    const result = await applyRetention(migratorUrl!);
    expect(result.find((r) => r.entity === 'run_events')?.affected).toBeGreaterThanOrEqual(1);
    const events = async (id: string) =>
      (await owner.query('SELECT 1 FROM commerce.run_events WHERE run_id = $1', [id])).rowCount;
    expect(await events(old)).toBe(0);
    expect(await events(recent)).toBeGreaterThan(0);
    const input = (
      await owner.query<{ input: unknown }>('SELECT input FROM commerce.agent_runs WHERE id = $1', [
        old,
      ])
    ).rows[0]?.input;
    expect(input).toEqual({});
    expect(
      (await owner.query('SELECT 1 FROM commerce.audit_events WHERE id = $1', [oldAudit])).rowCount,
    ).toBe(0);
    expect(
      (
        await owner.query(
          "SELECT 1 FROM commerce.audit_events WHERE recorded_at > now() - interval '1 day'",
        )
      ).rowCount,
    ).toBeGreaterThan(0);
  });

  it('cannot be executed by the runtime role', async () => {
    await expect(runtime.query('SELECT * FROM commerce.apply_retention(now())')).rejects.toThrow(
      /permission denied/,
    );
  });
});
