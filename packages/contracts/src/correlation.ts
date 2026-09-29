import { randomUUID } from 'node:crypto';

export const CORRELATION_HEADER = 'x-correlation-id';
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

export interface NormalizedCorrelationId {
  readonly id: string;
  readonly source: 'client' | 'generated';
}

/**
 * Accepts a client-provided correlation id only when it matches CORRELATION_ID_PATTERN, so
 * untrusted header content never reaches logs or trace attributes verbatim.
 */
export function normalizeCorrelationId(
  value: string | readonly string[] | null | undefined,
  generate: () => string = randomUUID,
): NormalizedCorrelationId {
  const candidate: string | null | undefined =
    typeof value === 'string' || value == null ? value : value[0];
  if (typeof candidate === 'string' && CORRELATION_ID_PATTERN.test(candidate)) {
    return { id: candidate, source: 'client' };
  }
  return { id: generate(), source: 'generated' };
}
