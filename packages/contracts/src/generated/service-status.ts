/* Generated from schemas/ by scripts/generate-types.mjs. Do not edit. */

/**
 * Diagnostic response of GET /v1/status. Echoes the correlation id so a caller can find the request in structured logs.
 */
export interface ServiceStatus {
  service: 'api';
  version: string;
  status: 'ok';
  correlation_id: string;
  observed_at: string;
}
