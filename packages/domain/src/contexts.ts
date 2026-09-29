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
