import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  INTENTS,
  ROUTER_MODEL,
  ROUTER_STRATEGIES,
  SELECTED_ROUTER,
  routeMessage,
  trainNaiveBayes,
  type RouterStrategy,
} from '@commerce/ai';
import { loadDataset, type EvalCase, type LoadedDataset } from './fixtures.js';
import { buildReport, observed, type EvalReport, type EvalResult } from './report.js';

interface RouterExpected {
  readonly intents: readonly string[];
  readonly decision: string;
}

export interface ClassScores {
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly support: number;
}

export interface RouterMetrics {
  readonly cases: number;
  readonly macroF1: number;
  readonly perClass: Readonly<Record<string, ClassScores>>;
  readonly exactSet: number;
  readonly decisionAccuracy: number;
  /** expected primary intent -> predicted primary intent -> count (single-intent cases). */
  readonly confusion: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly errors: readonly string[];
  readonly modelCalls: number;
}

/**
 * Multi-label macro-F1 over the four allowed intents: each case contributes TP/FP/FN per class
 * from its predicted and expected intent sets. Clarifications without an intent count as an
 * empty prediction. Classes without support are excluded from the macro average, never counted
 * as successes.
 */
export function scoreRouter(
  cases: readonly EvalCase[],
  strategy: RouterStrategy,
  model = ROUTER_MODEL,
): RouterMetrics {
  const tp: Record<string, number> = {};
  const fp: Record<string, number> = {};
  const fn: Record<string, number> = {};
  const confusion: Record<string, Record<string, number>> = {};
  const errors: string[] = [];
  let exact = 0;
  let decisions = 0;
  let modelCalls = 0;
  for (const c of cases) {
    const expected = c.expected as RouterExpected;
    const result = routeMessage((c.input as { message: string }).message, { strategy, model });
    modelCalls += result.modelCalls;
    const predicted = new Set<string>(result.intents);
    const wanted = new Set(expected.intents);
    for (const intent of INTENTS) {
      if (predicted.has(intent) && wanted.has(intent)) tp[intent] = (tp[intent] ?? 0) + 1;
      else if (predicted.has(intent)) fp[intent] = (fp[intent] ?? 0) + 1;
      else if (wanted.has(intent)) fn[intent] = (fn[intent] ?? 0) + 1;
    }
    const sameSet = predicted.size === wanted.size && [...wanted].every((i) => predicted.has(i));
    const sameDecision = result.decision === expected.decision;
    if (sameSet) exact += 1;
    if (sameDecision) decisions += 1;
    if (!sameSet || !sameDecision) {
      errors.push(
        `${c.id}: expected ${[...wanted].join('+')}/${expected.decision}, got ${[...predicted].join('+') || '∅'}/${result.decision}`,
      );
    }
    if (wanted.size === 1) {
      const e = [...wanted][0] ?? '';
      const p =
        result.intents.length === 1
          ? (result.intents[0] ?? '∅')
          : result.intents.length === 0
            ? '∅'
            : 'multi';
      confusion[e] ??= {};
      const row = confusion[e];
      row[p] = (row[p] ?? 0) + 1;
    }
  }
  const perClass: Record<string, ClassScores> = {};
  for (const intent of INTENTS) {
    const t = tp[intent] ?? 0;
    const support = t + (fn[intent] ?? 0);
    const precision = t + (fp[intent] ?? 0) === 0 ? 0 : t / (t + (fp[intent] ?? 0));
    const recall = support === 0 ? 0 : t / support;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    perClass[intent] = { precision: r(precision), recall: r(recall), f1: r(f1), support };
  }
  const supported = Object.values(perClass).filter((s) => s.support > 0);
  return {
    cases: cases.length,
    macroF1: r(supported.reduce((sum, s) => sum + s.f1, 0) / supported.length),
    perClass,
    exactSet: r(exact / cases.length),
    decisionAccuracy: r(decisions / cases.length),
    confusion,
    errors,
    modelCalls,
  };
}

function r(value: number): number {
  return Number(value.toFixed(3));
}

async function modelDrift(dataset: LoadedDataset, dir: string): Promise<boolean> {
  const raw = await readFile(join(dir, 'train.jsonl'), 'utf8');
  const retrained = trainNaiveBayes(
    dataset.cases
      .filter((c) => c.suite === 'train')
      .map((c) => ({
        text: (c.input as { message: string }).message,
        label: (c.expected as RouterExpected).intents[0] ?? '',
      })),
    { version: ROUTER_MODEL.version, trainedOn: ROUTER_MODEL.trainedOn },
  );
  return (
    JSON.stringify(retrained) !== JSON.stringify(ROUTER_MODEL) ||
    !ROUTER_MODEL.trainedOn.endsWith(
      (await import('node:crypto')).createHash('sha256').update(raw).digest('hex'),
    )
  );
}

export async function runRouterSuites(fixturesRoot: string): Promise<EvalReport[]> {
  const dir = join(fixturesRoot, 'router', '0.1.0');
  const dataset = await loadDataset(dir);
  const drift = await modelDrift(dataset, dir);
  const reports: EvalReport[] = [];
  for (const split of ['dev', 'holdout'] as const) {
    const startedAt = new Date();
    const cases = dataset.cases.filter((c) => c.suite === split);
    const results: EvalResult[] = [];
    for (const strategy of ROUTER_STRATEGIES) {
      const m = scoreRouter(cases, strategy);
      const selected = strategy === SELECTED_ROUTER.strategy ? ' (selected)' : '';
      const key = strategy.replace('+', '_plus_');
      const common = {
        dimension: 'intent_routing',
        source: 'packages/ai/src/router/router.ts',
        denominator: m.cases,
      };
      results.push(
        observed('MEASURED', {
          ...common,
          metric: `intent_macro_f1_${key}`,
          unit: 'ratio',
          value: m.macroF1,
          notes: `${strategy}${selected}. Per class F1/support: ${Object.entries(m.perClass)
            .map(([k, v]) => `${k} ${String(v.f1)}/${String(v.support)}`)
            .join(
              ', ',
            )}. Confusion (expected→predicted): ${JSON.stringify(m.confusion)}. Model calls: ${String(m.modelCalls)}.`,
        }),
        observed('MEASURED', {
          ...common,
          metric: `intent_exact_set_${key}`,
          unit: 'ratio',
          value: m.exactSet,
        }),
        observed('MEASURED', {
          ...common,
          metric: `route_decision_accuracy_${key}`,
          unit: 'ratio',
          value: m.decisionAccuracy,
          notes: m.errors.length ? `Errors: ${m.errors.join('; ')}` : 'No errors.',
        }),
      );
    }
    if (split === 'dev') {
      results.push(
        observed('MEASURED', {
          metric: 'router_model_drift',
          dimension: 'intent_routing',
          unit: 'count',
          source: 'packages/ai/models/nb-model.v1.json',
          value: drift ? 1 : 0,
          denominator: 1,
          threshold: { operator: '==', value: 0 },
          notes: 'Committed classifier equals a retrain on router@0.1.0 train (same sha256).',
        }),
      );
    }
    reports.push(
      buildReport({
        suite: `router-${split}`,
        target: {
          id: SELECTED_ROUTER.id,
          mode: 'real',
          description:
            'Supervisor router executed in-process: explicit rules, a local Naive Bayes classifier trained on the train split, and both combined. No LLM is called.',
        },
        startedAt,
        results,
        dataset: {
          id: dataset.manifest.id,
          version: dataset.manifest.version,
          sha256: dataset.sha256,
          cases: cases.length,
        },
      }),
    );
  }
  return reports;
}
