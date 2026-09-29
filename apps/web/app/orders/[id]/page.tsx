import { cookies } from 'next/headers';
import { apiGet, sessionFromCookie } from '../../../lib/session';

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = sessionFromCookie((await cookies()).toString());
  const order = (await apiGet(session, `/v1/orders/${id}`)) as {
    code?: string;
    status?: string;
    items?: { title_snapshot: string; quantity: number }[];
  };
  const shipping = (await apiGet(session, `/v1/orders/${id}/shipping`)) as {
    shipments?: { tracking_ref: string; status: string; stale: boolean; source_mode: string }[];
  };
  if (order.code === 'NOT_FOUND') {
    return (
      <section>
        <h1>Orden no encontrada</h1>
        <p>Sin datos de cliente ni envío.</p>
      </section>
    );
  }
  return (
    <section>
      <h1>Investigación de orden</h1>
      <p>Estado: {order.status}. Cancelación solicitada ≠ pedido cancelado.</p>
      <h2>Líneas</h2>
      <ul>
        {(order.items ?? []).map((item) => (
          <li key={item.title_snapshot}>
            {item.title_snapshot} × {item.quantity}
          </li>
        ))}
      </ul>
      <h2>Envíos (simulado)</h2>
      <ul>
        {(shipping.shipments ?? []).map((s) => (
          <li key={s.tracking_ref}>
            {s.tracking_ref}: {s.status}
            {s.stale ? ' · tracking stale' : ''} · fuente {s.source_mode}
          </li>
        ))}
      </ul>
    </section>
  );
}
