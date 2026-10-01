import { ApiState, Empty } from '../../components/ApiState';
import { api, requireSession } from '../../lib/api';
import { when } from '../../lib/format';

interface TicketList {
  items: {
    id: string;
    orderId: string | null;
    category: string;
    status: string;
    summary: string;
    createdAt?: string;
  }[];
}

export default async function TicketsPage() {
  const session = await requireSession();
  const result = await api<TicketList>(session, '/v1/support-tickets');
  return (
    <section>
      <h1>Tickets de soporte</h1>
      <p className="muted">
        Un ticket sólo se crea con tu confirmación explícita. Crearlo no envía emails ni notifica a
        terceros (notificaciones simuladas fuera del MVP).
      </p>
      <ApiState result={result} what="los tickets" />
      {result.ok &&
        (result.body.items.length === 0 ? (
          <Empty>Bandeja vacía.</Empty>
        ) : (
          <table aria-label="Tickets">
            <thead>
              <tr>
                <th scope="col">Estado</th>
                <th scope="col">Categoría</th>
                <th scope="col">Orden</th>
                <th scope="col">Resumen</th>
                <th scope="col">Creado</th>
              </tr>
            </thead>
            <tbody>
              {result.body.items.map((t) => (
                <tr key={t.id}>
                  <td>{t.status}</td>
                  <td>{t.category}</td>
                  <td>{t.orderId ?? '—'}</td>
                  <td>{t.summary}</td>
                  <td>{when(t.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </section>
  );
}
