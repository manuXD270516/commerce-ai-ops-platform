import { createRequire } from 'node:module';
import { predictNaiveBayes, type NaiveBayesModel } from './naive-bayes.js';
import { INTENTS, matchRules, type Intent } from './rules.js';
import { extractSlots, type Slots } from './slots.js';

const require = createRequire(import.meta.url);

/** Trained by `pnpm --filter @commerce/ai run train-router` from router@0.1.0 train only. */
export const ROUTER_MODEL = require('../../models/nb-model.v1.json') as NaiveBayesModel;

export const ROUTER_STRATEGIES = ['rules', 'classifier', 'rules+classifier'] as const;
export type RouterStrategy = (typeof ROUTER_STRATEGIES)[number];

/** Selected in M6 (add-agent-router design.md) by macro-F1 on the dev split. */
export const SELECTED_ROUTER: { readonly id: string; readonly strategy: RouterStrategy } = {
  id: 'router.v1',
  strategy: 'rules+classifier',
};

/**
 * Below this posterior the classifier's answer is treated as ambiguous and the user is asked to
 * clarify. Chosen on the dev split; a probability from this model is a calibrated-on-dev score,
 * not a guarantee.
 */
export const CLASSIFIER_MIN_CONFIDENCE = 0.6;

export type RouteDecision = 'route' | 'clarify' | 'out_of_scope';

export interface RouteResult {
  readonly decision: RouteDecision;
  readonly intents: readonly Intent[];
  readonly slots: Slots;
  readonly source: 'ui_context' | 'rules' | 'classifier' | 'none';
  /** Present when the classifier decided; the posterior of the chosen intent. */
  readonly confidence?: number;
  /** Machine-readable reason for clarify/out_of_scope; never model prose. */
  readonly reason?: 'missing_order_id' | 'multiple_order_ids' | 'ambiguous' | 'unsupported_request';
  /** Number of model calls made (the classifier counts as one; rules count as zero). */
  readonly modelCalls: number;
}

export interface RouteOptions {
  readonly strategy?: RouterStrategy;
  /** An explicit, authenticated UI context (e.g. the order screen) resolves the intent first. */
  readonly uiContext?: { readonly intent: Intent; readonly orderId?: string };
  readonly model?: NaiveBayesModel;
}

/**
 * Supervisor routing: UI context, then explicit rules, then the bounded classifier. It only
 * chooses among allowed intents and asks for missing slots; it never invents an order id and
 * never decides business rules.
 */
export function routeMessage(message: string, options: RouteOptions = {}): RouteResult {
  const strategy = options.strategy ?? SELECTED_ROUTER.strategy;
  const extracted = extractSlots(message);
  const slots: Slots =
    options.uiContext?.orderId && extracted.orderIds.length === 0
      ? { ...extracted, orderIds: [options.uiContext.orderId] }
      : extracted;

  let intents: Intent[] = [];
  let source: RouteResult['source'] = 'none';
  let confidence: number | undefined;
  let modelCalls = 0;
  if (options.uiContext) {
    intents = [options.uiContext.intent];
    source = 'ui_context';
  } else if (strategy !== 'classifier') {
    const rules = matchRules(message, slots);
    if (rules.matched) {
      intents = [...rules.intents];
      source = 'rules';
    }
  }
  if (intents.length === 0 && strategy !== 'rules' && !options.uiContext) {
    const posterior = predictNaiveBayes(options.model ?? ROUTER_MODEL, message);
    modelCalls = 1;
    const [best, p] = Object.entries(posterior).sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
    source = 'classifier';
    confidence = p;
    if (p < CLASSIFIER_MIN_CONFIDENCE || !isIntent(best)) {
      return {
        decision: 'clarify',
        intents: [],
        slots,
        source,
        confidence,
        reason: 'ambiguous',
        modelCalls,
      };
    }
    intents = [best];
  }
  if (intents.length === 0) {
    // Rules-only strategy with no match: refuse rather than guess.
    return {
      decision: 'out_of_scope',
      intents: ['out_of_scope'],
      slots,
      source,
      reason: 'unsupported_request',
      modelCalls,
    };
  }
  if (intents.includes('out_of_scope')) {
    return {
      decision: 'out_of_scope',
      intents: ['out_of_scope'],
      slots,
      source,
      ...(confidence === undefined ? {} : { confidence }),
      reason: 'unsupported_request',
      modelCalls,
    };
  }
  const base = {
    intents,
    slots,
    source,
    ...(confidence === undefined ? {} : { confidence }),
    modelCalls,
  };
  if (intents.includes('order_investigation') && slots.orderIds.length !== 1) {
    return {
      ...base,
      decision: 'clarify',
      reason: slots.orderIds.length === 0 ? 'missing_order_id' : 'multiple_order_ids',
    };
  }
  return { ...base, decision: 'route' };
}

function isIntent(value: string): value is Intent {
  return (INTENTS as readonly string[]).includes(value);
}
