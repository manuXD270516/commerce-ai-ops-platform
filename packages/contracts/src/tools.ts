import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** The eight MCP tools of the MVP contract (docs/agents-security-mcp.md). Order is stable. */
export const TOOL_NAMES = [
  'search_products',
  'get_product',
  'check_inventory',
  'get_order',
  'get_customer',
  'get_shipping_status',
  'create_support_ticket',
  'update_order',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * Application policy, not MCP annotations: READ has no side effects, WRITE is a bounded reversible
 * effect that needs explicit consent, PRIVILEGED changes commercial state and needs approval.
 */
export type ToolClassification = 'READ' | 'WRITE' | 'PRIVILEGED';

export const TOOL_CLASSIFICATION: Record<ToolName, ToolClassification> = {
  search_products: 'READ',
  get_product: 'READ',
  check_inventory: 'READ',
  get_order: 'READ',
  get_customer: 'READ',
  get_shipping_status: 'READ',
  create_support_ticket: 'WRITE',
  update_order: 'PRIVILEGED',
};

/** Strict JSON Schema 2020-12 for a tool's arguments (schemas/tools, additionalProperties false). */
export function loadToolInputSchema(name: ToolName): Record<string, unknown> {
  return require(`../schemas/tools/${name}.input.schema.json`) as Record<string, unknown>;
}

export function isToolName(value: unknown): value is ToolName {
  return typeof value === 'string' && (TOOL_NAMES as readonly string[]).includes(value);
}
