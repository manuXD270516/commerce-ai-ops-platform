/* Generated from schemas/ by scripts/generate-types.mjs. Do not edit. */

export interface ApiError {
  code:
    | 'VALIDATION_ERROR'
    | 'NOT_FOUND'
    | 'FORBIDDEN'
    | 'CONFLICT'
    | 'APPROVAL_REQUIRED'
    | 'BUDGET_EXCEEDED'
    | 'DEPENDENCY_UNAVAILABLE';
  message: string;
  correlation_id: string;
}
