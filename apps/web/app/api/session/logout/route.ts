import { NextResponse } from 'next/server';
import { sameOrigin } from '../../../../lib/api';
import { SESSION_COOKIE } from '../../../../lib/session';

export function POST(request: Request): Response {
  if (!sameOrigin(request)) return new NextResponse('forbidden', { status: 403 });
  const res = new NextResponse(null, { status: 303, headers: { location: '/login' } });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
