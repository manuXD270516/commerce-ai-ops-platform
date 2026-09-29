import type { LoadedDataset } from './fixtures.js';
import {
  buildReport,
  observed,
  type EvalReport,
  type EvalResult,
  type Threshold,
} from './report.js';
import type { EvalTarget } from './targets.js';

export interface SuiteDefinition {
  readonly suite: string;
  readonly metric: string;
  readonly dimension: string;
  readonly source: string;
  readonly threshold?: Threshold;
  readonly notes?: string;
}

/**
 * Runs every case of `definition.suite` against the target and reports exact-match accuracy with
 * its denominator. Status derives from the target mode, never from the caller.
 */
export function runExactMatchSuite(
  dataset: LoadedDataset,
  target: EvalTarget,
  definition: SuiteDefinition,
): EvalReport {
  const startedAt = new Date();
  const cases = dataset.cases.filter((c) => c.suite === definition.suite);
  if (cases.length === 0) throw new Error(`No cases for suite ${definition.suite}`);
  const failures = cases.filter((c) => target.run(c) !== c.expected).map((c) => c.id);
  const numerator = cases.length - failures.length;
  const result: EvalResult = observed(target.mode === 'real' ? 'MEASURED' : 'SIMULATED', {
    metric: definition.metric,
    dimension: definition.dimension,
    unit: 'ratio',
    source: definition.source,
    value: numerator / cases.length,
    numerator,
    denominator: cases.length,
    ...(definition.threshold ? { threshold: definition.threshold } : {}),
    notes: [definition.notes, failures.length ? `mismatches: ${failures.join(', ')}` : undefined]
      .filter(Boolean)
      .join(' '),
  });
  return buildReport({
    suite: definition.suite,
    target: { id: target.id, mode: target.mode, description: target.description },
    startedAt,
    results: [result],
    dataset: {
      id: dataset.manifest.id,
      version: dataset.manifest.version,
      sha256: dataset.sha256,
      cases: cases.length,
    },
  });
}
