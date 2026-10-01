import { TOOL_NAMES } from '@commerce/contracts';
import { describe, expect, it } from 'vitest';
import { ROLE_SCOPES, TOOL_DEFINITIONS, effectiveScopes, toolAllowed } from '../src/index.js';

describe('scope policy', () => {
  it('intersects role, client and specialist profile', () => {
    expect(effectiveScopes('customer')).toEqual(ROLE_SCOPES.customer);
    expect(effectiveScopes('customer', ['orders:read', 'customers:read:support'])).toEqual([
      'orders:read',
    ]);
    expect(effectiveScopes('support', undefined, ['orders:read', 'shipping:read'])).toEqual([
      'orders:read',
      'shipping:read',
    ]);
    expect(effectiveScopes('support', [], undefined)).toEqual([]);
  });

  it('never lets inventory, approver or admin reach orders commands or tickets', () => {
    for (const role of ['inventory', 'approver', 'admin'] as const) {
      const scopes = effectiveScopes(role);
      expect(toolAllowed('update_order', scopes)).toBe(false);
      expect(toolAllowed('create_support_ticket', scopes)).toBe(false);
    }
    expect(toolAllowed('get_order', effectiveScopes('inventory'))).toBe(false);
    expect(toolAllowed('check_inventory', effectiveScopes('inventory'))).toBe(true);
  });

  it('publishes eight strict schemas with the contract classification', () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    expect(TOOL_DEFINITIONS.map((t) => t.classification)).toEqual([
      'READ',
      'READ',
      'READ',
      'READ',
      'READ',
      'READ',
      'WRITE',
      'PRIVILEGED',
    ]);
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });
});
