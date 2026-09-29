/* Generated from schemas/ by scripts/generate-types.mjs. Do not edit. */

export interface AgentRun {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'WAITING_HUMAN' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  intent?: string | null;
  observed_at: string;
}
