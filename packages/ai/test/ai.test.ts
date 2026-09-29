import { describe, expect, it } from 'vitest';
import { PROVIDER_MODES } from '../src/index.js';

describe('ai package scaffold', () => {
  it('exposes only real and simulated provider modes', () => {
    expect(PROVIDER_MODES).toEqual(['real', 'simulated']);
  });
});
