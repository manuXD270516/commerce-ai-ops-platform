import { describe, expect, it } from 'vitest';
import {
  blindSheet,
  cohenKappa,
  compareLabels,
  type DatasetCase,
  type SheetRow,
} from '../src/adjudication.js';

const inv = (id: string, escalation: boolean): DatasetCase => ({
  id,
  suite: 'dev',
  family: 'inv',
  category: 'investigation',
  input: { role: 'customer', message: `¿Dónde está mi pedido ${id}?` },
  expected: {
    intents: ['order_investigation'],
    decision: 'route',
    tools_required: ['get_order', 'get_shipping_status'],
    tools_forbidden: ['update_order'],
    effects: 'none',
    escalation,
  },
});

describe('label adjudication', () => {
  it('builds a blind sheet without the author labels', () => {
    const [row] = blindSheet([inv('a', true)]);
    expect(row?.labels).toEqual({
      intents: null,
      decision: null,
      tools_required: null,
      tools_forbidden: null,
      effects: null,
      escalation: null,
    });
    expect(JSON.stringify(row)).not.toContain('get_shipping_status');
  });

  it('computes Cohen kappa (perfect, chance-level and textbook values)', () => {
    expect(cohenKappa(['y', 'n', 'y'], ['y', 'n', 'y'])).toBe(1);
    // 20 items: both "yes" 7, both "no" 8, author yes/reviewer no 3, author no/reviewer yes 2.
    const rep = (v: string, k: number): string[] => Array.from({ length: k }, () => v);
    const a = [...rep('y', 7), ...rep('n', 8), ...rep('y', 3), ...rep('n', 2)];
    const b = [...rep('y', 7), ...rep('n', 8), ...rep('n', 3), ...rep('y', 2)];
    expect(cohenKappa(a, b)).toBeCloseTo(0.5, 3);
  });

  it('compares order-insensitive sets, lists disagreements and missing cases', () => {
    const cases = [inv('a', true), inv('b', false), inv('c', true)];
    const filled = (id: string, escalation: boolean, tools: string[]): SheetRow => ({
      id,
      category: 'investigation',
      input: { role: 'customer', message: '' },
      labels: {
        intents: ['order_investigation'],
        decision: 'route',
        tools_required: tools,
        tools_forbidden: ['update_order'],
        effects: 'none',
        escalation,
      },
      notes: '',
    });
    const report = compareLabels(cases, [
      filled('a', true, ['get_shipping_status', 'get_order']),
      filled('b', true, ['get_order', 'get_shipping_status']),
    ]);
    expect(report.labelled).toBe(2);
    expect(report.missing).toEqual(['c']);
    expect(report.fields.find((f) => f.field === 'tools_required')?.agree).toBe(2);
    expect(report.disagreements).toEqual([
      { id: 'b', field: 'escalation', author: false, reviewer: true },
    ]);
  });
});
