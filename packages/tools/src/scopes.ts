import type { ToolName } from '@commerce/contracts';
import type { Role } from '@commerce/domain';

/** Scope catalog of policy.v1 (docs/agents-security-mcp.md, contrato MCP). */
export const SCOPES = [
  'catalog:read',
  'inventory:read',
  'orders:read',
  'customers:read:self',
  'customers:read:support',
  'shipping:read',
  'tickets:create',
  'orders:request-cancellation',
] as const;
export type Scope = (typeof SCOPES)[number];

/**
 * What each membership role may ever do through tools. Admin manages configuration, not orders,
 * and holds no approval power; approval is not a tool at all.
 */
export const ROLE_SCOPES: Record<Role, readonly Scope[]> = {
  customer: [
    'catalog:read',
    'inventory:read',
    'orders:read',
    'customers:read:self',
    'shipping:read',
    'tickets:create',
    'orders:request-cancellation',
  ],
  support: [
    'catalog:read',
    'inventory:read',
    'orders:read',
    'customers:read:support',
    'shipping:read',
    'tickets:create',
    'orders:request-cancellation',
  ],
  inventory: ['catalog:read', 'inventory:read'],
  approver: ['catalog:read', 'orders:read', 'shipping:read'],
  admin: ['catalog:read', 'inventory:read'],
};

/** A tool is callable when the effective scopes contain any of these. */
export const TOOL_SCOPES: Record<ToolName, readonly Scope[]> = {
  search_products: ['catalog:read'],
  get_product: ['catalog:read'],
  check_inventory: ['inventory:read'],
  get_order: ['orders:read'],
  get_customer: ['customers:read:self', 'customers:read:support'],
  get_shipping_status: ['shipping:read'],
  create_support_ticket: ['tickets:create'],
  update_order: ['orders:request-cancellation'],
};

export function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}

/**
 * Effective scopes are the intersection of the user's role, the client's granted scopes and, for
 * agent calls, the specialist's tool profile. A missing client or profile list restricts nothing;
 * an empty list allows nothing.
 */
export function effectiveScopes(
  role: Role,
  clientScopes?: readonly string[],
  profileScopes?: readonly string[],
): Scope[] {
  return ROLE_SCOPES[role].filter(
    (scope) =>
      (clientScopes === undefined || clientScopes.includes(scope)) &&
      (profileScopes === undefined || profileScopes.includes(scope)),
  );
}

export function toolAllowed(tool: ToolName, scopes: readonly Scope[]): boolean {
  return TOOL_SCOPES[tool].some((scope) => scopes.includes(scope));
}
