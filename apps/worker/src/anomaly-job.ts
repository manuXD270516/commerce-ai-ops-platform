import { randomUUID } from 'node:crypto';
import { anomalyDetectorActor, detectAnomalies, listTenantIds } from '@commerce/domain';
import type { Database } from '@commerce/domain';
import { runWithCorrelation } from '@commerce/telemetry';
import type { Kysely } from 'kysely';
import type { Logger } from 'pino';

export const ANOMALY_QUEUE = 'inventory-anomalies';
export const ANOMALY_SCHEDULER_ID = 'anomaly-sweep';
export const ANOMALY_EVERY_MS = 5 * 60 * 1000;

export interface AnomalySweepResult {
  readonly correlation_id: string;
  readonly tenants: number;
  readonly created: number;
  readonly failed_tenants: number;
}

/**
 * Runs the detector once per tenant under the explicit service identity. A failing tenant is
 * logged and does not stop the others; the next scheduled window retries it.
 */
export async function runAnomalySweep(
  db: Kysely<Database>,
  logger: Logger,
  now = new Date(),
): Promise<AnomalySweepResult> {
  const correlationId = randomUUID();
  return runWithCorrelation(correlationId, async () => {
    let created = 0;
    let failed = 0;
    const tenants = await listTenantIds(db);
    for (const tenantId of tenants) {
      try {
        const rows = await detectAnomalies(db, anomalyDetectorActor(tenantId, correlationId), now);
        created += rows.length;
      } catch (error) {
        failed += 1;
        logger.error(
          { tenant_id: tenantId, err: error instanceof Error ? error.message : String(error) },
          'anomaly sweep failed for tenant',
        );
      }
    }
    logger.info(
      { queue: ANOMALY_QUEUE, tenants: tenants.length, created, failed_tenants: failed },
      'anomaly sweep processed',
    );
    return {
      correlation_id: correlationId,
      tenants: tenants.length,
      created,
      failed_tenants: failed,
    };
  });
}
