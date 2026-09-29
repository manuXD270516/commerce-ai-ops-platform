import { cookies } from 'next/headers';
import { apiGet, sessionFromCookie } from '../../lib/session';

export default async function InventoryPage() {
  const session = sessionFromCookie((await cookies()).toString());
  if (session.role === 'customer') {
    return (
      <section>
        <h1>Inventario</h1>
        <p>Esta vista no está disponible para el rol customer.</p>
      </section>
    );
  }
  const data = (await apiGet(session, '/v1/anomalies')) as {
    items?: { ruleId: string; status: string; evidence: unknown }[];
  };
  return (
    <section>
      <h1>Alertas de inventario</h1>
      <p>El agente no ajusta stock. Sin PII de clientes.</p>
      {(data.items ?? []).length === 0 ? (
        <p>Sin alertas abiertas.</p>
      ) : (
        <ul>
          {(data.items ?? []).map((item, index) => (
            <li key={`${item.ruleId}-${index}`}>
              {item.ruleId} ({item.status})
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
