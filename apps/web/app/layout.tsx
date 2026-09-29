import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Commerce AI Ops — consola',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: '1.5rem', maxWidth: '72rem' }}>
        <a href="#contenido" style={{ position: 'absolute', left: '-999px' }}>
          Saltar al contenido
        </a>
        <header>
          <p>
            <strong>Datos sintéticos / envío simulado.</strong> La consola no muestra
            chain-of-thought.
          </p>
          <nav aria-label="Principal">
            <Link href="/">Inicio</Link>
            {' · '}
            <Link href="/catalog">Catálogo</Link>
            {' · '}
            <Link href="/orders/00000000-0000-4000-8000-000000000401">Orden Ana</Link>
            {' · '}
            <Link href="/inventory">Inventario</Link>
            {' · '}
            <Link href="/tickets">Tickets</Link>
            {' · '}
            <Link href="/approvals">Aprobaciones</Link>
          </nav>
        </header>
        <main id="contenido">{children}</main>
      </body>
    </html>
  );
}
