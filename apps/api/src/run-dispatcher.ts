import { randomUUID } from 'node:crypto';
import { AGENT_RUN_QUEUE, TemplateSynthesizer, createEmbedder, executeRun } from '@commerce/ai';
import type { DomainDb } from '@commerce/domain';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export const RUN_DISPATCHER = Symbol('RUN_DISPATCHER');

/**
 * Hands a run to whoever executes it. The run row in PostgreSQL is the durable record; a job is
 * only a notification, so a lost job is recovered by the worker's periodic sweep.
 */
export interface RunDispatcher {
  dispatch(tenantId: string, runId: string): Promise<void>;
  close(): Promise<void>;
}

/** Production path: a BullMQ job per run; the job id dedups repeated dispatches. */
export class QueueRunDispatcher implements RunDispatcher {
  private readonly connection: Redis;
  private readonly queue: Queue;

  constructor(redisUrl: string) {
    this.connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.connection.on('error', () => undefined);
    this.queue = new Queue(AGENT_RUN_QUEUE, { connection: this.connection });
  }

  async dispatch(tenantId: string, runId: string): Promise<void> {
    await this.queue.add(
      'run',
      { tenantId, runId },
      { jobId: `${runId}-${String(Date.now())}`, removeOnComplete: 1000, removeOnFail: 1000 },
    );
  }

  async close(): Promise<void> {
    await this.queue.close();
    await this.connection.quit().catch(() => undefined);
  }
}

/**
 * Local and test path without Redis: executes in this process, after the HTTP response, with the
 * same executor and leases as the worker.
 */
export class InlineRunDispatcher implements RunDispatcher {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly deps;

  constructor(db: DomainDb) {
    this.deps = {
      db,
      embedder: createEmbedder(),
      synthesizer: new TemplateSynthesizer(),
      workerId: `api-inline-${randomUUID().slice(0, 8)}`,
    };
  }

  dispatch(tenantId: string, runId: string): Promise<void> {
    const job: Promise<unknown> = executeRun(this.deps, tenantId, runId)
      .catch(() => undefined)
      .finally(() => this.pending.delete(job));
    this.pending.add(job);
    return Promise.resolve();
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }
}
