const API = process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';

export interface DemoSession {
  readonly tenantId: string;
  readonly subjectId: string;
  readonly label: string;
  readonly role: string;
}

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

export async function apiGet(session: DemoSession, path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    headers: {
      'x-tenant-id': session.tenantId,
      'x-subject-id': session.subjectId,
      'x-correlation-id': `web-${Date.now().toString().slice(-8)}`,
    },
    cache: 'no-store',
  });
  return res.json();
}
