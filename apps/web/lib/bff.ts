import { NextResponse } from 'next/server';
import { api, currentSession, sameOrigin, type ApiResult } from './api';
import type { DemoSession } from './session';

/**
 * Route-handler wrapper for browser mutations: requires the signed session and a same-origin
 * request (CSRF), then relays the API status and body unchanged so the UI shows exactly what the
 * server decided.
 */
export async function mutation(
  request: Request,
  fn: (session: DemoSession, body: Record<string, unknown>) => Promise<ApiResult<unknown>>,
): Promise<Response> {
  if (!sameOrigin(request)) {
    return NextResponse.json(
      { code: 'FORBIDDEN', message: 'cross-origin request' },
      { status: 403 },
    );
  }
  const session = await currentSession();
  if (!session) {
    return NextResponse.json(
      { code: 'UNAUTHENTICATED', message: 'sign in first' },
      { status: 401 },
    );
  }
  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return NextResponse.json(
      { code: 'VALIDATION_ERROR', message: 'invalid JSON' },
      { status: 400 },
    );
  }
  const result = await fn(session, body);
  return NextResponse.json(result.body, { status: result.status });
}

export function idempotencyKey(request: Request): Record<string, string> {
  const key = request.headers.get('idempotency-key');
  return key ? { 'idempotency-key': key } : {};
}

export { api };
