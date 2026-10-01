import Link from 'next/link';
import { ApiState, Empty } from '../../components/ApiState';
import { api, requireSession } from '../../lib/api';
import { usd, when } from '../../lib/format';

interface OrderList {
  items: { id: string; status: string; total_minor: number; version: number; created_at: string }[];
}

export default async function OrdersPage() {
  const session = await requireSession();
  const result = await api<OrderList>(session, '/v1/orders');
  return (
    <section>
      <h1>Órdenes</h1>
      <ApiState result={result} what="las órdenes" />
      {result.ok &&
        (result.body.items.length === 0 ? (
          <Empty>No hay órdenes visibles para tu usuario.</Empty>
        ) : (
          <table aria-label="Órdenes">
            <thead>
              <tr>
                <th scope="col">Orden</th>
                <th scope="col">Estado</th>
                <th scope="col">Total</th>
                <th scope="col">Versión</th>
                <th scope="col">Creada</th>
              </tr>
            </thead>
            <tbody>
              {result.body.items.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link href={`/orders/${o.id}`}>{o.id}</Link>
                  </td>
                  <td>{o.status}</td>
                  <td>{usd(o.total_minor)}</td>
                  <td>{o.version}</td>
                  <td>{when(o.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </section>
  );
}
