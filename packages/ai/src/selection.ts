import { HASH_EMBEDDER_MODEL } from '@commerce/domain';
import { ROUTER_MODEL, SELECTED_ROUTER } from './router/index.js';

export const PROVIDER_MODES = ['real', 'simulated'] as const;
export type ProviderMode = (typeof PROVIDER_MODES)[number];

/**
 * Configuration fixed in M6 (add-agent-router design.md, decision 1) and recorded in every run.
 * No commercial model is selected: the project runs without AI keys or paid calls, so synthesis is
 * a deterministic template (SIMULATED) and routing uses rules plus a local classifier.
 */
export const SELECTED_PROVIDER = {
  router: `${SELECTED_ROUTER.id}:${SELECTED_ROUTER.strategy}`,
  routerModel: ROUTER_MODEL.version,
  synthesizer: 'template-synth.v1',
  promptVersion: 'synth.v1',
  embeddings: HASH_EMBEDDER_MODEL,
  mode: 'simulated' as ProviderMode,
} as const;
