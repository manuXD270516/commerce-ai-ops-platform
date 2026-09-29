import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { AUDIENCES, signAccessToken, type LocalIssuerKeys } from '@commerce/contracts';

const API = process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';
const ISSUER = process.env.AUTH_ISSUER ?? 'http://127.0.0.1:3000/local-issuer';
const SIGNING_KEY_FILE = process.env.AUTH_SIGNING_KEY_FILE ?? '.local/auth/issuer-private.jwk.json';

export interface DemoSession {
  readonly tenantId: string;
  readonly subjectId: string;
  readonly label: string;
  readonly role: string;
}

/**
 * Local demo sign-in: the console acts as the development issuer and signs short-lived tokens
 * that the API verifies. Cloud deployments replace this with an OIDC provider.
 */
export const DEMO_USERS: readonly DemoSession[] = [
  {
    tenantId: '00000000-0000-4000-8000-000000000001',
    subjectId: 'acme-customer-ana',
    label: 'Ana (customer)',
    role: 'customer',
  },
  {
    tenantId: '00000000-0000-4000-8000-000000000001',
    subjectId: 'acme-support',
    label: 'Acme support',
    role: 'support',
  },
  {
    tenantId: '00000000-0000-4000-8000-000000000001',
    subjectId: 'acme-inventory',
    label: 'Acme inventory',
    role: 'inventory',
  },
  {
    tenantId: '00000000-0000-4000-8000-000000000001',
    subjectId: 'acme-approver',
    label: 'Acme approver',
    role: 'approver',
  },
];

export function sessionFromCookie(cookieHeader: string | null): DemoSession {
  const match = /subject=([^;]+)/.exec(cookieHeader ?? '');
  const fallback = DEMO_USERS[0];
  if (!fallback) throw new Error('No demo users configured');
  return DEMO_USERS.find((u) => u.subjectId === match?.[1]) ?? fallback;
}

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

export async function apiGet(session: DemoSession, path: string): Promise<unknown> {
  const token = signAccessToken(
    { subject: session.subjectId, tenantId: session.tenantId, audience: AUDIENCES.api },
    { issuer: ISSUER, privateJwk: loadSigningKey(), ttlSeconds: 300 },
  );
  const res = await fetch(`${API}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      'x-correlation-id': `web-${Date.now().toString().slice(-8)}`,
    },
    cache: 'no-store',
  });
  return res.json();
}
