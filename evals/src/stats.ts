/** 95% Wilson score interval for a proportion; [0, 0] style bounds when n = 0. */
export function wilson(successes: number, n: number, z = 1.96): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 0 };
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: round(Math.max(0, centre - margin)), high: round(Math.min(1, centre + margin)) };
}

/**
 * Upper 95% bound on an event rate when 0 events were observed in n trials (rule of three).
 * Zero observed failures does not prove zero risk.
 */
export function ruleOfThree(n: number): number {
  return n === 0 ? 1 : round(Math.min(1, 3 / n));
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export function median(values: readonly number[]): number {
  return percentile(values, 0.5);
}

export function round(value: number, digits = 3): number {
  return Number(value.toFixed(digits));
}
