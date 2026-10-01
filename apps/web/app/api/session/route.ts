import { NextResponse } from 'next/server';
import { sameOrigin } from '../../../lib/api';
import { DEMO_USERS, SESSION_COOKIE, sealSession } from '../../../lib/session';

/** Demo sign-in: sets a MAC-protected, HttpOnly, SameSite=Strict session cookie. */
export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return new NextResponse('forbidden', { status: 403 });
  const form = await request.formData();
  const raw = form.get('subject');
  const subject = typeof raw === 'string' ? raw : '';
  if (!DEMO_USERS.some((u) => u.subjectId === subject)) {
    return seeOther('/login');
  }
  const res = seeOther('/');
  res.cookies.set(SESSION_COOKIE, sealSession(subject), {
    httpOnly: true,
    sameSite: 'strict',
    // Behind the TLS proxy the app sees http; the proxy's header tells the real scheme.
    secure:
      request.headers.get('x-forwarded-proto') === 'https' ||
      new URL(request.url).protocol === 'https:',
    path: '/',
    maxAge: 8 * 3600,
  });
  return res;
}

/** Relative redirect: the browser stays on the host it used, so the cookie keeps applying. */
function seeOther(path: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { location: path } });
}
