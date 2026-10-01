import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, apiToken, openSession, type DemoSession } from './session';

export const API_BASE = process.env.API_BASE_URL ?? 'http://127.0.0.1:3001';

export interface ApiResult<T> {
  readonly status: number;
  readonly ok: boolean;
  readonly body: T;
  /** True when the API could not be reached at all (network error or timeout). */
  readonly unreachable: boolean;
}

export interface ApiErrorBody {
  readonly code?: string;
  readonly message?: string;
}

export async function currentSession(): Promise<DemoSession | undefined> {
  return openSession((await cookies()).get(SESSION_COOKIE)?.value);
}

/** Server components: the signed-in demo user, or a redirect to the sign-in page. */
export async function requireSession(): Promise<DemoSession> {
  const session = await currentSession();
  if (!session) redirect('/login');
  return session;
}

/**
 * Server-side call to the API with a short-lived token for the session subject. The browser never
 * sees the token. Failures come back as values so pages can render error and degraded states.
 */
export async function api<T = unknown>(
  session: DemoSession,
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${apiToken(session)}`,
        'x-correlation-id': `web-${randomUUID()}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    const body = (text ? JSON.parse(text) : {}) as T;
    return { status: res.status, ok: res.ok, body, unreachable: false };
  } catch {
    return {
      status: 503,
      ok: false,
      body: { code: 'DEPENDENCY_UNAVAILABLE', message: 'API no disponible' } as T,
      unreachable: true,
    };
  }
}

/**
 * Mutations from the browser only come through same-origin route handlers (SameSite=Strict cookie
 * plus an Origin check), never directly to the API.
 */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
