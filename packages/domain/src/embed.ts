import { createHash } from 'node:crypto';
import { EMBEDDING_DIM, EMBEDDING_MODEL } from './constants.js';

/** Deterministic local embedder. Not a vendor model; reports must label SIMULATED. */
export function embedText(text: string): number[] {
  const vector = Array.from({ length: EMBEDDING_DIM }, () => 0);
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9áéíóúñü]+/i)
    .filter((t) => t.length > 1);
  for (const token of tokens) {
    const digest = createHash('sha256').update(`${EMBEDDING_MODEL}:${token}`).digest();
    const index = (digest[0] ?? 0) % EMBEDDING_DIM;
    const sign = (digest[1] ?? 0) >= 128 ? 1 : -1;
    const mag = ((digest[2] ?? 0) + 1) / 256;
    vector[index] = (vector[index] ?? 0) + sign * mag;
  }
  const norm = Math.sqrt(vector.reduce((s, v) => s + v * v, 0)) || 1;
  return vector.map((v) => Number((v / norm).toFixed(6)));
}

export function vectorLiteral(values: readonly number[]): string {
  return `[${values.join(',')}]`;
}

export function checksumOf(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}
