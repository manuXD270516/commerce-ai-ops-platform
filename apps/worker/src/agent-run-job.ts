import { randomUUID } from 'node:crypto';
import {
  TemplateSynthesizer,
  createEmbedder,
  executeRun,
  type ExecutionReport,
  type ExecutorDeps,
} from '@commerce/ai';
import { listRecoverableRuns, listTenantIds, type DomainDb } from '@commerce/domain';
import type { Logger } from 'pino';

export { AGENT_RUN_QUEUE } from '@commerce/ai';
export const RUN_RECOVERY_QUEUE = 'agent-run-recovery';
export const RUN_RECOVERY_SCHEDULER_ID = 'agent-run-recovery-sweep';
export const RUN_RECOVERY_EVERY_MS = 30_000;

export interface AgentRunJobData {
  readonly tenantId: string;
  readonly runId: string;
}

export function executorDeps(
  db: DomainDb,
  workerId = `worker-${randomUUID().slice(0, 8)}`,
): ExecutorDeps {
  return { db, embedder: createEmbedder(), synthesizer: new TemplateSynthesizer(), workerId };
}

/** A job is a notification only: identity and authority are re-derived from the run row. */
export async function processAgentRunJob(
  deps: ExecutorDeps,
  logger: Logger,
  data: AgentRunJobData,
): Promise<ExecutionReport> {
  const report = await executeRun(deps, data.tenantId, data.runId);
  logger.info(
    { run_id: data.runId, status: report.status, outcome: report.outcome },
    'agent run processed',
  );
  return report;
}

/**
 * Rebuilds work from PostgreSQL: queued runs whose job was lost (e.g. Redis restarted), runs whose
 * worker died (expired lease) and waiting runs whose human decision arrived. Leases make a
 * concurrent duplicate a no-op.
 */
export async function runRecoverySweep(
  deps: ExecutorDeps,
  logger: Logger,
): Promise<{ resumed: number; skipped: number; failed: number }> {
  let resumed = 0;
  let skipped = 0;
  let failed = 0;
  for (const tenantId of await listTenantIds(deps.db)) {
    for (const runId of await listRecoverableRuns(deps.db, tenantId)) {
      try {
        const report = await executeRun(deps, tenantId, runId);
        if (report.status === 'SKIPPED') skipped += 1;
        else resumed += 1;
      } catch (error) {
        failed += 1;
        logger.error(
          { run_id: runId, err: error instanceof Error ? error.message : String(error) },
          'run recovery failed',
        );
      }
    }
  }
  if (resumed + failed > 0) logger.info({ resumed, skipped, failed }, 'agent run recovery sweep');
  return { resumed, skipped, failed };
}
