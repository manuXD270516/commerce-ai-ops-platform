import { randomUUID } from 'node:crypto';
import { API_BASE, currentSession } from '../../../../../lib/api';
import { apiToken } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';

/**
 * Same-origin SSE relay. The browser's EventSource reconnects with Last-Event-ID, which is passed
 * to the API so only missed events are replayed; reconnecting never starts a run.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await currentSession();
  if (!session) return new Response('unauthenticated', { status: 401 });
  const { id } = await params;
  const lastEventId = request.headers.get('last-event-id');
  let upstream: Response;
  try {
    upstream = await fetch(`${API_BASE}/v1/agent-runs/${encodeURIComponent(id)}/events`, {
      headers: {
        authorization: `Bearer ${apiToken(session)}`,
        accept: 'text/event-stream',
        'x-correlation-id': `web-sse-${randomUUID()}`,
        ...(lastEventId ? { 'last-event-id': lastEventId } : {}),
      },
      signal: request.signal,
      cache: 'no-store',
    });
  } catch {
    return new Response('api unavailable', { status: 503 });
  }
  if (!upstream.ok || !upstream.body) {
    return new Response(await upstream.text(), { status: upstream.status });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
