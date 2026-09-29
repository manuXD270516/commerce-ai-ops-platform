/* Generated from schemas/ by scripts/generate-types.mjs. Do not edit. */

export type ServiceName = 'web' | 'api' | 'worker' | 'commerce-mcp-server';

/**
 * Liveness/readiness report of a process. Carries no business data.
 */
export interface HealthReport {
  status: 'ok' | 'unavailable';
  service: ServiceName;
  version: string;
  observed_at: string;
  /**
   * @maxItems 16
   */
  checks: DependencyCheck[];
}
export interface DependencyCheck {
  name: 'postgres' | 'pgvector' | 'redis';
  status: 'up' | 'down';
  latency_ms: number;
}
