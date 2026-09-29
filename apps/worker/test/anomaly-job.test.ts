import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Writable } from 'node:stream';
import pg from 'pg';
import {
  ANOMALY_DETECTOR_SUBJECT,
  createDb,
  createPool,
  migrate,
  seedCommerceDomain,
} from '@commerce/domain';
import { createLogger } from '@commerce/telemetry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAnomalySweep } from '../src/anomaly-job.js';

const envFile = resolve(import.meta.dirname, '../../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const { DATABASE_ADMIN_URL, DATABASE_MIGRATOR_URL, DATABASE_URL, PII_ENCRYPTION_KEY } = process.env;
const enabled = Boolean(
  DATABASE_ADMIN_URL && DATABASE_MIGRATOR_URL && DATABASE_URL && PII_ENCRYPTION_KEY,
);

describe.skipIf(!enabled)('anomaly sweep job', () => {
  const pool = createPool(DATABASE_URL!);
  const db = createDb(pool);
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    service: 'worker',
    destination: new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
        callback();
      },
    }),
  });

  beforeAll(async () => {
    await migrate({
      adminUrl: DATABASE_ADMIN_URL!,
      migratorUrl: DATABASE_MIGRATOR_URL!,
      runtimeUrl: DATABASE_URL!,
    });
    await seedCommerceDomain(DATABASE_MIGRATOR_URL!, PII_ENCRYPTION_KEY!);
  }, 60_000);

  afterAll(async () => {
    await db.destroy();
  });

  it('sweeps every tenant under the service identity and is a no-op when repeated in the window', async () => {
    const now = new Date('2026-09-29T06:00:00.000Z');
    const first = await runAnomalySweep(db, logger, now);
    expect(first).toMatchObject({ tenants: 2, failed_tenants: 0 });
    expect(first.created).toBeGreaterThan(0);
    const again = await runAnomalySweep(db, logger, new Date(now.getTime() + 60_000));
    expect(again).toMatchObject({ tenants: 2, created: 0, failed_tenants: 0 });

    const owner = new pg.Client({ connectionString: DATABASE_MIGRATOR_URL });
    await owner.connect();
    try {
      const audit = await owner.query<{ tenant_id: string }>(
        `SELECT DISTINCT tenant_id FROM commerce.audit_events
          WHERE actor_subject_id = $1 AND action = 'anomalies.detect'`,
        [ANOMALY_DETECTOR_SUBJECT],
      );
      expect(audit.rows).toHaveLength(2);
    } finally {
      await owner.end();
    }
    expect(lines.at(-1)).toMatchObject({ msg: 'anomaly sweep processed', created: 0 });
    expect(typeof lines.at(-1)?.correlation_id).toBe('string');
  });
});
