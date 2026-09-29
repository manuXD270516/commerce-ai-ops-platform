import { createRequire } from 'node:module';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createHealthServer, createLogger, shutdownTracing } from '@commerce/telemetry';
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

const health = createHealthServer({
  service: 'worker',
  version,
  readiness: async () => {
    const started = performance.now();
    const ok = await connection.ping().then(
      () => true,
      () => false,
    );
    return [
      {
        name: 'redis',
        status: ok ? 'up' : 'down',
        latency_ms: Math.round(performance.now() - started),
      },
    ];
  },
});
health.listen(healthPort, host, () => {
  logger.info({ host, port: healthPort, queue: DIAGNOSTIC_QUEUE, version }, 'worker ready');
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'worker stopping');
  health.close();
  await worker.close();
  await connection.quit().catch(() => undefined);
  await shutdownTracing();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
