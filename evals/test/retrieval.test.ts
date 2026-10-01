import { describe, expect, it } from 'vitest';
import { scoreRetrieval, type RankedCase } from '../src/index.js';

const ranked = (id: string, relevant: string[], result: string[], forbidden: string[] = []) =>
  ({
    case: { id, role: 'customer', query: 'q', relevant, forbidden },
    ranked: result,
    latencyMs: 10,
  }) satisfies RankedCase;

describe('scoreRetrieval', () => {
  it('computes recall@5 and MRR@5 per case and counts every forbidden or foreign source', () => {
    const metrics = scoreRetrieval(
      [
        ranked('a', ['kb://acme/x'], ['kb://acme/x', 'kb://acme/y']),
        ranked('b', ['kb://acme/x', 'kb://acme/z'], ['kb://acme/y', 'kb://acme/z']),
        ranked(
          'c',
          ['kb://acme/x'],
          [
            'kb://acme/1',
            'kb://acme/2',
            'kb://acme/3',
            'kb://acme/4',
            'kb://acme/5',
            'kb://acme/x',
          ],
        ),
        ranked(
          'd',
          ['kb://acme/x'],
          ['kb://acme/x', 'kb://acme/secret', 'kb://globex/y'],
          ['kb://acme/secret'],
        ),
      ],
      'kb://acme/',
    );
    expect(metrics).toMatchObject({
      cases: 4,
      // (1 + 0.5 + 0 + 1) / 4: a relevant source at rank 6 does not count.
      recallAt5: 0.625,
      // (1 + 1/2 + 0 + 1) / 4
      mrrAt5: 0.625,
      forbiddenHits: 1,
      crossTenantHits: 1,
      misses: ['c'],
    });
  });
});
