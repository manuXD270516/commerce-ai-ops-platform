export const POLICY_VERSION = 'policy.v1';
export const ANOMALY_RULE_VERSION = 'anomaly.v1';
export const EMBEDDING_MODEL = 'local-hash-v1';
export const EMBEDDING_DIM = 32;
export const MAX_PAGE = 50;
export const STALE_TRACKING_MS = 6 * 60 * 60 * 1000;
export const ESCALATION_DELAY_MS = 48 * 60 * 60 * 1000;
export const APPROVAL_TTL_MS = 30 * 60 * 1000;
export const LEAD_TIME_DAYS = 7;
export const UNUSUAL_ORDER_MIN_OBS = 20;
export const ANOMALY_WINDOW_MS = 5 * 60 * 1000;
export const DEMAND_WINDOW_DAYS = 7;
/** Fewer distinct demand days than this in the window is reported as INSUFFICIENT_DATA. */
export const MIN_DEMAND_DAYS = 3;
/** Stock counts older than this are not "vigente" and cannot raise a discrepancy. */
export const STOCK_COUNT_MAX_AGE_MS = 72 * 60 * 60 * 1000;
