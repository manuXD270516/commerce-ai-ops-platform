import { tokenize } from '@commerce/domain';

/**
 * Multinomial Naive Bayes over normalized word unigrams and bigrams with Laplace smoothing. A
 * small, local and deterministic classifier: it returns a probability per allowed intent and
 * never sees ids, amounts or permissions (ids and digits are masked before training).
 */
export interface NaiveBayesModel {
  readonly version: string;
  /** sha256 of the training file, so a report can tell which data produced the model. */
  readonly trainedOn: string;
  readonly classes: readonly string[];
  readonly logPriors: Readonly<Record<string, number>>;
  readonly tokenCounts: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly totals: Readonly<Record<string, number>>;
  readonly vocabularySize: number;
}

export function features(text: string): string[] {
  const words = tokenize(
    text
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ' idtoken ')
      .replace(/\b[A-Z]{2,5}(?:-[A-Z0-9]{1,5}){1,3}\b/g, ' skutoken ')
      .replace(/\d+([.,]\d+)*/g, ' numtoken '),
  );
  const bigrams = words.slice(1).map((w, i) => `${words[i] ?? ''}_${w}`);
  return [...words, ...bigrams];
}

export function trainNaiveBayes(
  examples: readonly { readonly text: string; readonly label: string }[],
  meta: { version: string; trainedOn: string },
): NaiveBayesModel {
  const classes = [...new Set(examples.map((e) => e.label))].sort();
  const tokenCounts: Record<string, Record<string, number>> = {};
  const totals: Record<string, number> = {};
  const docs: Record<string, number> = {};
  const vocabulary = new Set<string>();
  for (const c of classes) {
    tokenCounts[c] = {};
    totals[c] = 0;
    docs[c] = 0;
  }
  for (const { text, label } of examples) {
    docs[label] = (docs[label] ?? 0) + 1;
    const counts = tokenCounts[label] ?? {};
    for (const f of features(text)) {
      vocabulary.add(f);
      counts[f] = (counts[f] ?? 0) + 1;
      totals[label] = (totals[label] ?? 0) + 1;
    }
  }
  const logPriors = Object.fromEntries(
    classes.map((c) => [c, round(Math.log((docs[c] ?? 0) / examples.length))]),
  );
  // Keys are sorted so the serialized model is byte-stable for the same training data.
  const sortedCounts = Object.fromEntries(
    classes.map((c) => [
      c,
      Object.fromEntries(
        Object.entries(tokenCounts[c] ?? {}).sort(([a], [b]) => a.localeCompare(b)),
      ),
    ]),
  );
  return {
    ...meta,
    classes,
    logPriors,
    tokenCounts: sortedCounts,
    totals,
    vocabularySize: vocabulary.size,
  };
}

/** Posterior probability per class, normalized with log-sum-exp. */
export function predictNaiveBayes(model: NaiveBayesModel, text: string): Record<string, number> {
  const tokens = features(text);
  const scores = model.classes.map((c) => {
    const counts = model.tokenCounts[c] ?? {};
    const denominator = (model.totals[c] ?? 0) + model.vocabularySize + 1;
    let score = model.logPriors[c] ?? Number.NEGATIVE_INFINITY;
    for (const t of tokens) score += Math.log(((counts[t] ?? 0) + 1) / denominator);
    return score;
  });
  const max = Math.max(...scores);
  const exp = scores.map((s) => Math.exp(s - max));
  const sum = exp.reduce((a, b) => a + b, 0);
  return Object.fromEntries(model.classes.map((c, i) => [c, round((exp[i] ?? 0) / sum)]));
}

function round(value: number): number {
  return Number(value.toFixed(6));
}
