import { describe, expect, it } from 'vitest';
import { BOUNDED_CONTEXTS } from '../src/index.js';

describe('domain package scaffold', () => {
  it('lists the nine bounded contexts of docs/architecture.md without duplicates', () => {
    expect(new Set(BOUNDED_CONTEXTS).size).toBe(9);
  });
});
