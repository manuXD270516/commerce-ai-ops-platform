import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import {
  FIXTURES,
  POLICY_VERSION,
  createAgentRun,
  createDb,
  createPool,
  getAgentRun,
  hashEmbedder,
  migrate,
  seedCommerceDomain,
  seedKnowledgeCorpus,
  type ActorContext,
} from '@commerce/domain';
import { createLogger } from '@commerce/telemetry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executorDeps, processAgentRunJob, runRecoverySweep } from '../src/agent-run-job.js';

const envFile = resolve(import.meta.dirname, '../../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const { DATABASE_ADMIN_URL, DATABASE_MIGRATOR_URL, DATABASE_URL, PII_ENCRYPTION_KEY } = process.env;
const enabled = Boolean(
  DATABASE_ADMIN_URL && DATABASE_MIGRATOR_URL && DATABASE_URL && PII_ENCRYPTION_KEY,
);

const ana: ActorContext = {
  tenantId: FIXTURES.tenants.acme,
  subjectId: FIXTURES.subjects.ana,
  role: 'customer',
  customerId: FIXTURES.customers.ana,
  policyVersion: POLICY_VERSION,
};

describe.skipIf(!enabled)('agent run jobs and recovery sweep', () => {
  const db = createDb(createPool(DATABASE_URL!));
  const logger = createLogger({
    service: 'worker',
    destination: new Writable({
      write: (_c, _e, cb) => {
        cb();
      },
    }),
  });
  const create = (message: string) =>
    createAgentRun(db, ana, {
      message,
      promptVersion: 'synth.v1',
      modelVersion: 'template-synth.v1',
      routerVersion: 'router.v1',
    });

  beforeAll(async () => {
    await migrate({
      adminUrl: DATABASE_ADMIN_URL!,
      migratorUrl: DATABASE_MIGRATOR_URL!,
      runtimeUrl: DATABASE_URL!,
    });
    await seedCommerceDomain(DATABASE_MIGRATOR_URL!, PII_ENCRYPTION_KEY!);
    await seedKnowledgeCorpus(db, hashEmbedder());
  }, 60_000);

  afterAll(async () => {
    await db.destroy();
  });

  it('executes a run from its job and ignores a duplicate delivery', async () => {
    const run = await create(`¿Dónde está mi pedido ${FIXTURES.orders.anaPartial}?`);
    const data = { tenantId: FIXTURES.tenants.acme, runId: run.id };
    expect(await processAgentRunJob(executorDeps(db), logger, data)).toMatchObject({
      status: 'COMPLETED',
    });
    expect(await processAgentRunJob(executorDeps(db), logger, data)).toMatchObject({
      status: 'SKIPPED',
    });
  });

  it('rebuilds queued work from PostgreSQL when the job notification was lost', async () => {
    // No job was ever enqueued for this run: the situation after Redis loses its state.
    const lost = await create('Recomiéndame una notebook de desarrollo por menos de USD 1.500');
    const sweep = await runRecoverySweep(executorDeps(db), logger);
    expect(sweep.resumed).toBeGreaterThanOrEqual(1);
    expect(await getAgentRun(db, ana, lost.id)).toMatchObject({
      status: 'COMPLETED',
      outcome: 'ANSWERED',
    });
    // A second sweep finds nothing left to do for it.
    await runRecoverySweep(executorDeps(db), logger);
    expect((await getAgentRun(db, ana, lost.id)).status).toBe('COMPLETED');
  });
});
