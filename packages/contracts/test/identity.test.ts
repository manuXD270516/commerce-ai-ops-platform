import { describe, expect, it } from 'vitest';
import {
  AUDIENCES,
  AccessTokenError,
  bearerToken,
  generateLocalIssuerKeys,
  signAccessToken,
  verifyAccessToken,
} from '../src/index.js';

const ISSUER = 'http://127.0.0.1:3000/local-issuer';
const TENANT = '00000000-0000-4000-8000-000000000001';
const keys = generateLocalIssuerKeys();
const now = new Date('2026-09-29T12:00:00Z');

function token(overrides: { audience?: (typeof AUDIENCES)['api' | 'mcp']; ttl?: number } = {}) {
  return signAccessToken(
    { subject: 'acme-ana', tenantId: TENANT, audience: overrides.audience ?? AUDIENCES.api },
    { issuer: ISSUER, privateJwk: keys.privateJwk, ttlSeconds: overrides.ttl, now },
  );
}

function reason(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof AccessTokenError) return error.reason;
    throw error;
  }
  return 'accepted';
}

describe('access tokens', () => {
  it('accepts a token signed by the configured issuer for the right audience', () => {
    const identity = verifyAccessToken(token(), {
      issuer: ISSUER,
      audience: AUDIENCES.api,
      jwks: keys.jwks,
      now,
    });
    expect(identity).toMatchObject({ subject: 'acme-ana', tenantId: TENANT });
  });

  it('rejects a token for another audience (no replay from MCP to API)', () => {
    const opts = { issuer: ISSUER, audience: AUDIENCES.api, jwks: keys.jwks, now };
    expect(reason(() => verifyAccessToken(token({ audience: AUDIENCES.mcp }), opts))).toBe(
      'audience',
    );
  });

  it('rejects another issuer, a foreign key, tampering, expiry and long lifetimes', () => {
    const opts = { issuer: ISSUER, audience: AUDIENCES.api, jwks: keys.jwks, now };
    expect(reason(() => verifyAccessToken(token(), { ...opts, issuer: 'https://evil' }))).toBe(
      'issuer',
    );
    const other = generateLocalIssuerKeys();
    expect(reason(() => verifyAccessToken(token(), { ...opts, jwks: other.jwks }))).toBe(
      'unknown kid',
    );
    const [h, p, s] = token().split('.');
    const forged = Buffer.from(
      JSON.stringify({
        ...(JSON.parse(Buffer.from(p ?? '', 'base64url').toString()) as object),
        tenant_id: '00000000-0000-4000-8000-000000000002',
      }),
    ).toString('base64url');
    expect(reason(() => verifyAccessToken(`${h}.${forged}.${s}`, opts))).toBe('bad signature');
    const later = new Date(now.getTime() + 3600_000);
    expect(reason(() => verifyAccessToken(token({ ttl: 60 }), { ...opts, now: later }))).toBe(
      'expired',
    );
    expect(reason(() => verifyAccessToken(token({ ttl: 7200 }), opts))).toBe('lifetime too long');
    expect(reason(() => verifyAccessToken('a.b.c', opts))).toBe('malformed');
  });

  it('extracts only well-formed bearer tokens', () => {
    expect(bearerToken(`Bearer ${token()}`)).toBeDefined();
    expect(bearerToken('Basic abc')).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });

  it('carries client scopes only as a well-formed scope claim', () => {
    const scoped = signAccessToken(
      { subject: 'acme-ana', tenantId: TENANT, audience: AUDIENCES.mcp, scopes: ['orders:read'] },
      { issuer: ISSUER, privateJwk: keys.privateJwk, now },
    );
    const options = { issuer: ISSUER, audience: AUDIENCES.mcp, jwks: keys.jwks, now };
    expect(verifyAccessToken(scoped, options).scopes).toEqual(['orders:read']);
    expect(verifyAccessToken(token({ audience: AUDIENCES.mcp }), options).scopes).toBeUndefined();
    const forged = signAccessToken(
      { subject: 'acme-ana', tenantId: TENANT, audience: AUDIENCES.mcp, scopes: ['Orders;DROP'] },
      { issuer: ISSUER, privateJwk: keys.privateJwk, now },
    );
    expect(reason(() => verifyAccessToken(forged, options))).toBe('scope');
  });
});
