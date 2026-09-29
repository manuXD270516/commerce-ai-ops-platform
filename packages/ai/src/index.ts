/**
 * Provider-neutral model adapters arrive in M6 (task 7.1). Until then no provider SDK is
 * installed and no model is called. ProviderMode is shared with evals so every report can say
 * whether a run used a real or a simulated provider.
 */
export const PROVIDER_MODES = ['real', 'simulated'] as const;

export type ProviderMode = (typeof PROVIDER_MODES)[number];
