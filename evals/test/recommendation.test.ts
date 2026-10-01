import { describe, expect, it } from 'vitest';
import { ndcgAt } from '../src/index.js';

describe('nDCG@3', () => {
  it('is 1 for the ideal order and penalizes swaps and unlabelled items', () => {
    const grades = { A: 3, B: 2, C: 0 };
    expect(ndcgAt(3, ['A', 'B'], grades)).toBe(1);
    const swapped = ndcgAt(3, ['B', 'A'], grades);
    expect(swapped).toBeGreaterThan(0.7);
    expect(swapped).toBeLessThan(1);
    expect(ndcgAt(3, ['X', 'A', 'B'], grades)).toBeLessThan(swapped);
    expect(ndcgAt(3, [], grades)).toBe(0);
  });
});
