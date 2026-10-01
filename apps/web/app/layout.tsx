import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { currentSession } from '../lib/api';
import type { Role } from '../lib/session';
import './globals.css';

export const metadata: Metadata = {
  title: 'Commerce AI Ops — consola',
  robots: { index: false, follow: false },
};

/** Navigation by role is a convenience; every view is authorized again by the API. */
const LINKS: readonly { href: string; label: string; roles: readonly Role[] }[] = [
  { href: '/', label: 'Inicio', roles: ['customer', 'support', 'inventory', 'approver', 'admin'] },
  { href: '/runs', label: 'Asistente', roles: ['customer', 'support', 'inventory', 'approver'] },
  {
    href: '/catalog',
    label: 'Catálogo',
    roles: ['customer', 'support', 'inventory', 'approver', 'admin'],
  },
  { href: '/orders', label: 'Órdenes', roles: ['customer', 'support', 'approver'] },
  { href: '/inventory', label: 'Inventario', roles: ['inventory', 'support', 'approver', 'admin'] },
  { href: '/tickets', label: 'Tickets', roles: ['customer', 'support', 'approver', 'admin'] },
  { href: '/approvals', label: 'Aprobaciones', roles: ['customer', 'support', 'approver'] },
];

export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = await currentSession();
  return (
    <html lang="es">
      <body>
        <a className="skip-link" href="#contenido">
          Saltar al contenido
        </a>
        <div className="shell">
          <header className="top">
            <p className="notice sim" role="note">
              <span className="badge sim">Datos sintéticos</span> Transportistas y notificaciones
              simulados. Las respuestas del asistente se redactan con una plantilla determinística
              (SIMULATED); la consola nunca muestra razonamiento interno.
            </p>
            {session ? (
              <div>
                <span>
                  Sesión: <strong>{session.label}</strong>{' '}
                  <span className="muted">({session.role})</span>
                </span>{' '}
                <form action="/api/session/logout" method="post" style={{ display: 'inline' }}>
                  <button type="submit" className="secondary">
                    Salir
                  </button>
                </form>
                <nav aria-label="Principal">
                  <ul>
                    {LINKS.filter((l) => l.roles.includes(session.role)).map((l) => (
                      <li key={l.href}>
                        <Link href={l.href}>{l.label}</Link>
                      </li>
                    ))}
                  </ul>
                </nav>
              </div>
            ) : (
              <Link href="/login">Ingresar</Link>
            )}
          </header>
          <main id="contenido" tabIndex={-1}>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
