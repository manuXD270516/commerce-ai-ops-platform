/* Generated from schemas/ by scripts/generate-types.mjs. Do not edit. */

export interface AgentRun {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'WAITING_HUMAN' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  outcome?:
    | null
    | 'ANSWERED'
    | 'CLARIFICATION_REQUESTED'
    | 'REFUSED'
    | 'BUDGET_EXCEEDED'
    | 'ACCESS_REVOKED'
    | 'CANCELLED'
    | 'ACTION_EXECUTED'
    | 'ACTION_REJECTED'
    | 'ACTION_FAILED'
    | 'ERROR';
  intent?: string | null;
  usage?: Counters;
  budgets?: Counters;
  router_version?: string | null;
  model_version?: string | null;
  prompt_version?: string | null;
  cancel_requested?: boolean;
  created_at?: string;
  updated_at?: string;
  observed_at: string;
}
export interface Counters {
  llmCalls: number;
  toolCalls: number;
  tokens: number;
  activeMs: number;
}
