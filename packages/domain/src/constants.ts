export const POLICY_VERSION = 'policy.v1';
export const ANOMALY_RULE_VERSION = 'anomaly.v1';
/** Fixed by the M4 embedding spike (add-hybrid-retrieval design.md); the schema column matches. */
export const EMBEDDING_DIM = 384;
/** Reciprocal Rank Fusion inputs and output size (docs/rag-evals.md starting point). */
export const CANDIDATE_K = 30;
export const CONTEXT_K = 6;
export const RRF_K = 60;
/** Chunk budget in approximate tokens (whitespace words); docs/rag-evals.md: 300–600, overlap ≤ 60. */
export const CHUNK_MAX_TOKENS = 450;
export const CHUNK_OVERLAP_TOKENS = 60;
export const RETRIEVAL_CACHE_TTL_MS = 5 * 60 * 1000;
export const MAX_RECOMMENDATIONS = 3;
export const MAX_PAGE = 50;
export const STALE_TRACKING_MS = 6 * 60 * 60 * 1000;
export const ESCALATION_DELAY_MS = 48 * 60 * 60 * 1000;
/** ActionRequest lifetime (docs/agents-security-mcp.md: 15 minutes). */
export const APPROVAL_TTL_MS = 15 * 60 * 1000;
export const LEAD_TIME_DAYS = 7;
export const UNUSUAL_ORDER_MIN_OBS = 20;
export const ANOMALY_WINDOW_MS = 5 * 60 * 1000;
export const DEMAND_WINDOW_DAYS = 7;
/** Fewer distinct demand days than this in the window is reported as INSUFFICIENT_DATA. */
export const MIN_DEMAND_DAYS = 3;
/** Stock counts older than this are not "vigente" and cannot raise a discrepancy. */
export const STOCK_COUNT_MAX_AGE_MS = 72 * 60 * 60 * 1000;
/** A WRITE consent recorded by the UI is valid this long and consumed at most once (M5). */
export const CONSENT_TTL_MS = 15 * 60 * 1000;
/** Ticket creation limit per subject, enforced in PostgreSQL so a Redis outage cannot relax it. */
export const TICKETS_PER_SUBJECT_PER_HOUR = 5;
