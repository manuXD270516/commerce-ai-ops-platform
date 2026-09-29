import { normalizeCorrelationId } from '@commerce/contracts';
import { runWithCorrelation } from '@commerce/telemetry';
import type { Logger } from 'pino';

/**
 * Infrastructure-only queue used by the M0 smoke to prove a correlation id survives a Redis hop.
 * It carries no business payload; agent runs and outbox dispatch arrive in M6.
 */
export const DIAGNOSTIC_QUEUE = 'system-diagnostics';

export interface DiagnosticJobData {
  readonly correlation_id?: unknown;
}

export interface DiagnosticJobResult {
  readonly correlation_id: string;
  readonly processed_at: string;
}

export function processDiagnosticJob(
  logger: Logger,
  jobId: string | undefined,
  data: DiagnosticJobData,
): DiagnosticJobResult {
  const correlationId = normalizeCorrelationId(
    typeof data.correlation_id === 'string' ? data.correlation_id : undefined,
  ).id;
  return runWithCorrelation(correlationId, () => {
    logger.info({ queue: DIAGNOSTIC_QUEUE, job_id: jobId }, 'diagnostic job processed');
    return { correlation_id: correlationId, processed_at: new Date().toISOString() };
  });
}
