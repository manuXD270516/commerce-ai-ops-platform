import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { AUDIENCES, signAccessToken, type LocalIssuerKeys } from '@commerce/contracts';

const ISSUER = process.env.AUTH_ISSUER ?? 'http://127.0.0.1:3000/local-issuer';
const SIGNING_KEY_FILE = process.env.AUTH_SIGNING_KEY_FILE ?? '.local/auth/issuer-private.jwk.json';
export const SESSION_COOKIE = 'console_session';

export type Role = 'customer' | 'support' | 'inventory' | 'approver' | 'admin';

export interface DemoSession {
  readonly tenantId: string;
  readonly subjectId: string;
  readonly label: string;
  readonly role: Role;
}

const ACME = '00000000-0000-4000-8000-000000000001';

/**
 * Local demo sign-in: the console acts as the development issuer and signs short-lived tokens
 * that the API verifies against its JWKS. The role shown here is only a label; the API reads the
 * real role from the membership. Cloud deployments replace this with an OIDC provider.
 */
export const DEMO_USERS: readonly DemoSession[] = [
  { tenantId: ACME, subjectId: 'acme-customer-ana', label: 'Ana (cliente)', role: 'customer' },
  { tenantId: ACME, subjectId: 'acme-customer-ben', label: 'Ben (cliente)', role: 'customer' },
  { tenantId: ACME, subjectId: 'acme-support', label: 'Soporte Acme', role: 'support' },
  { tenantId: ACME, subjectId: 'acme-inventory', label: 'Inventario Acme', role: 'inventory' },
  { tenantId: ACME, subjectId: 'acme-approver', label: 'Aprobador Acme', role: 'approver' },
  { tenantId: ACME, subjectId: 'acme-admin', label: 'Admin Acme', role: 'admin' },
];

let signingKey: LocalIssuerKeys['privateJwk'] | undefined;

function loadSigningKey(): LocalIssuerKeys['privateJwk'] {
  if (signingKey) return signingKey;
  let root = process.cwd();
  while (!existsSync(join(root, 'pnpm-workspace.yaml')) && dirname(root) !== root) {
    root = dirname(root);
  }
  const path = isAbsolute(SIGNING_KEY_FILE) ? SIGNING_KEY_FILE : join(root, SIGNING_KEY_FILE);
  signingKey = JSON.parse(readFileSync(path, 'utf8')) as LocalIssuerKeys['privateJwk'];
  return signingKey;
}

/** Cookie MAC key derived from the issuer key, so a client cannot forge another subject. */
function macKey(): Buffer {
  return createHash('sha256')
    .update(`${String(loadSigningKey().d)}:console-session.v1`)
    .digest();
}

export function sealSession(subjectId: string): string {
  const mac = createHmac('sha256', macKey()).update(subjectId).digest('base64url');
  return `${subjectId}.${mac}`;
}

export function openSession(value: string | undefined): DemoSession | undefined {
  if (!value) return undefined;
  const dot = value.lastIndexOf('.');
  if (dot < 1) return undefined;
  const subject = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1), 'base64url');
  const expected = createHmac('sha256', macKey()).update(subject).digest();
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  return DEMO_USERS.find((u) => u.subjectId === subject);
}

export function apiToken(session: DemoSession): string {
  return signAccessToken(
    { subject: session.subjectId, tenantId: session.tenantId, audience: AUDIENCES.api },
    { issuer: ISSUER, privateJwk: loadSigningKey(), ttlSeconds: 300 },
  );
}
