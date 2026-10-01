export interface RetrievalCase {
  readonly id: string;
  readonly role: string;
  readonly query: string;
  readonly relevant: readonly string[];
  readonly forbidden: readonly string[];
}

export interface RankedCase {
  readonly case: RetrievalCase;
  /** Distinct source URIs in rank order, as returned to the caller. */
  readonly ranked: readonly string[];
  readonly latencyMs: number;
}

export interface RetrievalMetrics {
  readonly cases: number;
  readonly recallAt5: number;
  readonly mrrAt5: number;
  readonly forbiddenHits: number;
  readonly crossTenantHits: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly misses: readonly string[];
}

export function distinctInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Recall@5 averages, per case, the share of relevant sources in the top five distinct sources;
 * MRR@5 averages 1/rank of the first relevant one (0 when absent). Forbidden sources count
 * anywhere in the result, not only in the top five.
 */
export function scoreRetrieval(
  results: readonly RankedCase[],
  tenantPrefix: string,
): RetrievalMetrics {
  let recall = 0;
  let mrr = 0;
  let forbiddenHits = 0;
  let crossTenantHits = 0;
  const misses: string[] = [];
  for (const { case: c, ranked } of results) {
    const top = ranked.slice(0, 5);
    const found = c.relevant.filter((r) => top.includes(r)).length;
    recall += c.relevant.length === 0 ? 1 : found / c.relevant.length;
    const first = top.findIndex((r) => c.relevant.includes(r));
    mrr += first === -1 ? 0 : 1 / (first + 1);
    if (first === -1) misses.push(c.id);
    forbiddenHits += ranked.filter((r) => c.forbidden.includes(r)).length;
    crossTenantHits += ranked.filter((r) => !r.startsWith(tenantPrefix)).length;
  }
  const n = results.length;
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  return {
    cases: n,
    recallAt5: round(recall / n),
    mrrAt5: round(mrr / n),
    forbiddenHits,
    crossTenantHits,
    p50Ms: round(percentile(latencies, 0.5)),
    p95Ms: round(percentile(latencies, 0.95)),
    misses,
  };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)] ?? 0;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}
