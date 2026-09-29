import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { DEMO_USERS } from '../../../lib/session';

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const raw = form.get('subject');
  const subject = typeof raw === 'string' ? raw : '';
  const known = DEMO_USERS.some((u) => u.subjectId === subject);
  const res = NextResponse.redirect(new URL('/', request.url));
  if (known) res.cookies.set('subject', subject, { httpOnly: true, sameSite: 'lax', path: '/' });
  return res;
}

export async function GET(): Promise<Response> {
  const jar = await cookies();
  return NextResponse.json({ subject: jar.get('subject')?.value ?? null });
}
