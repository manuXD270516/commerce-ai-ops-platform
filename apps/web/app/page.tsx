import Link from 'next/link';
import { requireSession } from '../lib/api';

export default async function HomePage() {
  const session = await requireSession();
  return (
    <section>
      <h1>Consola operacional</h1>
      <p>
        Hola, <strong>{session.label}</strong>. El backend es la autoridad: esta consola sólo
        muestra lo que tu membership permite y ninguna acción se da por hecha hasta que el servidor
        la confirma.
      </p>
      <ul>
        {session.role === 'customer' && (
          <>
            <li>
              <Link href="/runs">Consultar una orden o pedir una recomendación</Link> al asistente.
            </li>
            <li>
              <Link href="/orders">Ver tus órdenes</Link> con su timeline de envío.
            </li>
          </>
        )}
        {session.role === 'support' && (
          <li>
            <Link href="/runs">Investigar órdenes</Link> y abrir tickets con evidencia, siempre con
            confirmación explícita.
          </li>
        )}
        {session.role === 'inventory' && (
          <li>
            <Link href="/inventory">Alertas y balances</Link>: las reglas no ajustan stock.
          </li>
        )}
        {session.role === 'approver' && (
          <li>
            <Link href="/approvals">Bandeja de aprobación</Link>: revisás solicitudes de otros
            usuarios; nunca las tuyas.
          </li>
        )}
        {session.role === 'admin' && (
          <li>Admin gestiona configuración; no aprueba ni opera órdenes.</li>
        )}
      </ul>
    </section>
  );
}
