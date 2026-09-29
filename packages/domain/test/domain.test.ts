import { describe, expect, it } from 'vitest';
import { decryptEmail, encryptEmail, hashEmail } from '../src/pii.js';
import { payloadHash } from '../src/idempotency.js';
import { BOUNDED_CONTEXTS } from '../src/contexts.js';

const KEY = 'a'.repeat(64);

describe('domain package scaffold', () => {
  it('lists the nine bounded contexts of docs/architecture.md without duplicates', () => {
    expect(new Set(BOUNDED_CONTEXTS).size).toBe(9);
  });
});

describe('pii', () => {
  it('round-trips email and keeps a stable hash', () => {
    const blob = encryptEmail('Ana@Acme.test', KEY);
    expect(decryptEmail(blob, KEY)).toBe('ana@acme.test');
    expect(hashEmail('Ana@Acme.test').equals(hashEmail('ana@acme.test'))).toBe(true);
    expect(blob.includes(Buffer.from('ana@acme.test'))).toBe(false);
  });
});

describe('idempotency hash', () => {
  it('is independent of key order', () => {
    expect(payloadHash({ b: 1, a: 2 })).toBe(payloadHash({ a: 2, b: 1 }));
  });
});
