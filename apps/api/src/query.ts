import { DomainError } from '@commerce/domain';

type FieldKind = 'string' | 'int';
type Parsed<S extends Record<string, FieldKind>> = {
  [K in keyof S]?: S[K] extends 'int' ? number : string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Strict query parsing: unknown or repeated parameters and non-integer numbers are rejected. */
export function parseQuery<S extends Record<string, FieldKind>>(
  query: Record<string, unknown>,
  spec: S,
): Parsed<S> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(query)) {
    const kind = spec[key];
    if (!kind) throw new DomainError('VALIDATION_ERROR', `Unknown query parameter: ${key}`);
    if (typeof value !== 'string') {
      throw new DomainError('VALIDATION_ERROR', `Query parameter must appear once: ${key}`);
    }
    if (kind === 'int') {
      if (!/^\d{1,15}$/.test(value)) {
        throw new DomainError('VALIDATION_ERROR', `${key} must be a non-negative integer`);
      }
      out[key] = Number(value);
    } else {
      if (value.length === 0 || value.length > 128) {
        throw new DomainError('VALIDATION_ERROR', `${key} must be 1-128 characters`);
      }
      out[key] = value;
    }
  }
  return out as Parsed<S>;
}

export function requireUuid(value: string, field: string): string {
  if (!UUID.test(value)) throw new DomainError('VALIDATION_ERROR', `${field} must be a UUID`);
  return value;
}
