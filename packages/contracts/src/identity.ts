import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
  type JsonWebKey,
} from 'node:crypto';

/** Audiences are separate so a token issued for one entry point cannot be replayed on another. */
export const AUDIENCES = { api: 'commerce-api', mcp: 'commerce-mcp' } as const;
export type Audience = (typeof AUDIENCES)[keyof typeof AUDIENCES];

export const MAX_TOKEN_TTL_SECONDS = 3600;
const CLOCK_SKEW_SECONDS = 30;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBJECT_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;
const SCOPE_PATTERN = /^[a-z][a-z:-]{0,63}( [a-z][a-z:-]{0,63}){0,31}$/;

export interface VerifiedIdentity {
  readonly subject: string;
  readonly tenantId: string;
  readonly audience: Audience;
  readonly expiresAt: Date;
  /**
   * OAuth-style `scope` claim granted to the client. Undefined when the token carries none; an
   * entry point decides whether that means no client restriction (API) or no tools (MCP).
   */
  readonly scopes?: readonly string[];
}

export interface Jwks {
  readonly keys: readonly (JsonWebKey & { kid?: string })[];
}

export interface VerifyOptions {
  readonly issuer: string;
  readonly audience: Audience;
  readonly jwks: Jwks;
  readonly now?: Date;
}

export class AccessTokenError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid access token: ${reason}`);
    this.name = 'AccessTokenError';
  }
}

export function bearerToken(authorization: string | undefined): string | undefined {
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(
    authorization?.trim() ?? '',
  );
  return match?.[1];
}

/** Verifies an ES256 JWT: signature against the JWKS, then iss, aud, exp, nbf, iat and claims. */
export function verifyAccessToken(token: string, options: VerifyOptions): VerifiedIdentity {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AccessTokenError('malformed');
  const [rawHeader = '', rawPayload = '', rawSignature = ''] = parts;
  const header = decodeJson(rawHeader);
  if (header.alg !== 'ES256' || header.typ !== 'JWT') throw new AccessTokenError('unsupported alg');
  const jwk = options.jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new AccessTokenError('unknown kid');
  const valid = verify(
    'sha256',
    Buffer.from(`${rawHeader}.${rawPayload}`),
    { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
    Buffer.from(rawSignature, 'base64url'),
  );
  if (!valid) throw new AccessTokenError('bad signature');

  const claims = decodeJson(rawPayload);
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (claims.iss !== options.issuer) throw new AccessTokenError('issuer');
  if (claims.aud !== options.audience) throw new AccessTokenError('audience');
  const { exp, iat, nbf, sub, tenant_id: tenantId } = claims;
  if (typeof exp !== 'number' || typeof iat !== 'number') throw new AccessTokenError('exp/iat');
  if (exp <= now - CLOCK_SKEW_SECONDS) throw new AccessTokenError('expired');
  if (iat > now + CLOCK_SKEW_SECONDS) throw new AccessTokenError('issued in the future');
  if (exp - iat > MAX_TOKEN_TTL_SECONDS) throw new AccessTokenError('lifetime too long');
  if (typeof nbf === 'number' && nbf > now + CLOCK_SKEW_SECONDS) {
    throw new AccessTokenError('not yet valid');
  }
  if (typeof sub !== 'string' || !SUBJECT_PATTERN.test(sub)) throw new AccessTokenError('sub');
  if (typeof tenantId !== 'string' || !UUID_PATTERN.test(tenantId)) {
    throw new AccessTokenError('tenant_id');
  }
  const { scope } = claims;
  if (scope !== undefined && (typeof scope !== 'string' || !SCOPE_PATTERN.test(scope))) {
    throw new AccessTokenError('scope');
  }
  return {
    subject: sub,
    tenantId,
    audience: options.audience,
    expiresAt: new Date(exp * 1000),
    ...(scope === undefined ? {} : { scopes: scope.split(' ') }),
  };
}

export interface LocalIssuerKeys {
  readonly privateJwk: JsonWebKey & { kid: string };
  readonly jwks: Jwks;
}

/** Key pair for the local development issuer; cloud deployments verify tokens from an OIDC provider. */
export function generateLocalIssuerKeys(): LocalIssuerKeys {
  const kid = randomUUID();
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    privateJwk: { ...privateKey.export({ format: 'jwk' }), kid },
    jwks: { keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' }] },
  };
}

export function signAccessToken(
  input: { subject: string; tenantId: string; audience: Audience; scopes?: readonly string[] },
  options: {
    issuer: string;
    privateJwk: JsonWebKey & { kid: string };
    ttlSeconds?: number;
    now?: Date;
  },
): string {
  const iat = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const header = encodeJson({ alg: 'ES256', typ: 'JWT', kid: options.privateJwk.kid });
  const payload = encodeJson({
    iss: options.issuer,
    aud: input.audience,
    sub: input.subject,
    tenant_id: input.tenantId,
    ...(input.scopes ? { scope: input.scopes.join(' ') } : {}),
    iat,
    exp: iat + (options.ttlSeconds ?? 900),
    jti: randomUUID(),
  });
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), {
    key: createPrivateKey({ key: options.privateJwk, format: 'jwk' }),
    dsaEncoding: 'ieee-p1363',
  });
  return `${header}.${payload}.${signature.toString('base64url')}`;
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeJson(segment: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw new AccessTokenError('malformed');
}
