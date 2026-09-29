import { createRequire } from 'node:module';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { sql } from 'kysely';
import type { DependencyCheck } from '@commerce/contracts';
import { createDb, createPool } from '@commerce/domain';
import { createHealthServer, createLogger, shutdownTracing } from '@commerce/telemetry';
import {
  ANOMALY_EVERY_MS,
  ANOMALY_QUEUE,
  ANOMALY_SCHEDULER_ID,
  runAnomalySweep,
  type AnomalySweepResult,
} from './anomaly-job.js';
import {
  DIAGNOSTIC_QUEUE,
  processDiagnosticJob,
  type DiagnosticJobData,
  type DiagnosticJobResult,
} from './diagnostic-job.js';

const logger = createLogger({ service: 'worker' });
const version = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  logger.fatal('REDIS_URL is required');
  process.exit(1);
}
const healthPort = Number(process.env.WORKER_HEALTH_PORT ?? 3002);
const host = process.env.WORKER_HOST ?? '127.0.0.1';

const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
connection.on('error', (error: Error) => {
  logger.warn({ err: error.message }, 'redis error');
});

const worker = new Worker<DiagnosticJobData, DiagnosticJobResult>(
  DIAGNOSTIC_QUEUE,
  (job) => Promise.resolve(processDiagnosticJob(logger, job.id, job.data)),
  { connection, concurrency: 1 },
);
worker.on('failed', (job, error) => {
  logger.error({ job_id: job?.id, err: error.message }, 'job failed');
});

const databaseUrl = process.env.DATABASE_URL;
const db = databaseUrl ? createDb(createPool(databaseUrl)) : undefined;
const anomalyQueue = db ? new Queue(ANOMALY_QUEUE, { connection }) : undefined;
const anomalyWorker = db
  ? new Worker<unknown, AnomalySweepResult>(ANOMALY_QUEUE, () => runAnomalySweep(db, logger), {
      connection,
      concurrency: 1,
    })
  : undefined;
anomalyWorker?.on('failed', (job, error) => {
  logger.error({ job_id: job?.id, err: error.message }, 'anomaly sweep failed');
});
if (anomalyQueue) {
  await anomalyQueue.upsertJobScheduler(ANOMALY_SCHEDULER_ID, { every: ANOMALY_EVERY_MS });
} else {
  logger.warn('DATABASE_URL is not set; the anomaly sweep is disabled');
}

async function probe(
  name: DependencyCheck['name'],
  check: () => Promise<unknown>,
): Promise<DependencyCheck> {
  const started = performance.now();
  const ok = await check().then(
    () => true,
    () => false,
  );
  return {
    name,
    status: ok ? 'up' : 'down',
    latency_ms: Math.round(performance.now() - started),
  };
}

const health = createHealthServer({
  service: 'worker',
  version,
  readiness: async () => [
    await probe('redis', () => connection.ping()),
    ...(db ? [await probe('postgres', () => sql`SELECT 1`.execute(db))] : []),
  ],
});
health.listen(healthPort, host, () => {
  logger.info(
    { host, port: healthPort, queues: [DIAGNOSTIC_QUEUE, ...(db ? [ANOMALY_QUEUE] : [])], version },
    'worker ready',
  );
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'worker stopping');
  health.close();
  await worker.close();
  await anomalyWorker?.close();
  await anomalyQueue?.close();
  await db?.destroy();
  await connection.quit().catch(() => undefined);
  await shutdownTracing();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
