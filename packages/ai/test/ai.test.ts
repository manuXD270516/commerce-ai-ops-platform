import { describe, expect, it } from 'vitest';
import { PROVIDER_MODES, classifyIntent, SELECTED_PROVIDER } from '../src/index.js';

describe('ai package', () => {
  it('exposes only real and simulated provider modes', () => {
    expect(PROVIDER_MODES).toEqual(['real', 'simulated']);
  });

  it('routes order, recommendation, inventory and clarification deterministically', () => {
    expect(classifyIntent('atraso de 00000000-0000-4000-8000-000000000401').intent).toBe('order');
    expect(classifyIntent('notebook de desarrollo por menos de USD 1500').intent).toBe(
      'recommendation',
    );
    expect(classifyIntent('alerta de stock crítico').intent).toBe('inventory');
    expect(classifyIntent('qué pasó con mi pedido').intent).toBe('clarify');
    expect(SELECTED_PROVIDER.mode).toBe('simulated');
  });
});
