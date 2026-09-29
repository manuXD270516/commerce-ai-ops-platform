import { normalizeCorrelationId } from '@commerce/contracts';
import type { ProviderMode } from '@commerce/ai';
import type { EvalCase } from './fixtures.js';

export interface EvalTarget {
  readonly id: string;
  readonly mode: ProviderMode;
  readonly description: string;
  run(evalCase: EvalCase): unknown;
}

/** Real code: the correlation-id contract shared by web, api, worker and MCP. */
export const correlationContractTarget: EvalTarget = {
  id: '@commerce/contracts#normalizeCorrelationId',
  mode: 'real',
  description: 'Correlation id acceptance rule executed in-process',
  run: (evalCase) =>
    normalizeCorrelationId(
      typeof evalCase.input === 'string' ? evalCase.input : undefined,
      () => 'generated-by-harness',
    ).source,
};

/**
 * Replays the fixture's simulated_output. Exercises the reporting path of provider-shaped suites
 * without calling any model; its results are always labelled SIMULATED.
 */
export const simulatedProviderTarget: EvalTarget = {
  id: 'simulated-provider',
  mode: 'simulated',
  description: 'Deterministic replay of fixture outputs; no model is called',
  run: (evalCase) => evalCase.simulated_output,
};
