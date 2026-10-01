import { createHash } from 'node:crypto';
import { EMBEDDING_DIM } from './constants.js';

/**
 * Produces vectors for chunks and queries. The domain only depends on this contract; model
 * adapters live outside it. Vectors must be L2-normalised and exactly EMBEDDING_DIM long.
 */
export interface Embedder {
  readonly model: string;
  readonly dimension: number;
  embedDocuments(texts: readonly string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

export const HASH_EMBEDDER_MODEL = 'local-hash-v1';

/**
 * Deterministic bag-of-tokens baseline. It has no semantics beyond shared tokens; it exists as
 * the spike's lexical baseline and for tests that must not download a model.
 */
export function hashEmbedder(): Embedder {
  const embed = (text: string) => {
    const vector = Array.from({ length: EMBEDDING_DIM }, () => 0);
    for (const token of tokenize(text)) {
      const digest = createHash('sha256').update(`${HASH_EMBEDDER_MODEL}:${token}`).digest();
      const index = digest.readUInt16BE(0) % EMBEDDING_DIM;
      const sign = (digest[2] ?? 0) >= 128 ? 1 : -1;
      vector[index] = (vector[index] ?? 0) + sign;
    }
    return normalize(vector);
  };
  return {
    model: HASH_EMBEDDER_MODEL,
    dimension: EMBEDDING_DIM,
    embedDocuments: (texts) => Promise.resolve(texts.map(embed)),
    embedQuery: (text) => Promise.resolve(embed(text)),
  };
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

export function normalize(vector: readonly number[]): number[] {
  const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

export function vectorLiteral(values: readonly number[]): string {
  return `[${values.map((v) => v.toFixed(7)).join(',')}]`;
}

export function checksumOf(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}
