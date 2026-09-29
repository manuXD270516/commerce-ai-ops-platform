/**
 * Application services per bounded context (docs/architecture.md §1) start in M1. This package must stay
 * framework-agnostic and must not import @commerce/ai: business rules never depend on a model.
 */
export const BOUNDED_CONTEXTS = [
  'catalog',
  'inventory',
  'orders',
  'fulfillment',
  'customers',
  'support',
  'knowledge',
  'ai-operations',
  'access-governance',
] as const;

export type BoundedContext = (typeof BOUNDED_CONTEXTS)[number];
