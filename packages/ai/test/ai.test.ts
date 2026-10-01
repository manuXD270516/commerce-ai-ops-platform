import { describe, expect, it } from 'vitest';
import { PROVIDER_MODES, classifyIntent, createEmbedder, SELECTED_PROVIDER } from '../src/index.js';

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

describe('embedder selection', () => {
  it('defaults to the deterministic local hash embedder with no network access', async () => {
    const embedder = createEmbedder({});
    expect(embedder.model).toBe('local-hash-v1');
    const [a, b] = await Promise.all([
      embedder.embedQuery('notebook de desarrollo'),
      embedder.embedQuery('notebook de desarrollo'),
    ]);
    expect(a).toEqual(b);
    expect(a).toHaveLength(384);
  });

  it('keeps ONNX models opt-in and refuses unknown providers or models', () => {
    expect(createEmbedder({ EMBEDDINGS_PROVIDER: 'local-onnx' }).model).toBe(
      'multilingual-e5-small@761b726-q8',
    );
    expect(() => createEmbedder({ EMBEDDINGS_PROVIDER: 'openai' })).toThrow();
    expect(() =>
      createEmbedder({ EMBEDDINGS_PROVIDER: 'local-onnx', EMBEDDINGS_MODEL: 'x' }),
    ).toThrow();
  });

  it('does not download weights unless explicitly allowed', async () => {
    // Nothing is cached under .local/models in this repo, and remote models are disabled.
    const embedder = createEmbedder({ EMBEDDINGS_PROVIDER: 'local-onnx' });
    await expect(embedder.embedQuery('hola')).rejects.toThrow();
  });
});
