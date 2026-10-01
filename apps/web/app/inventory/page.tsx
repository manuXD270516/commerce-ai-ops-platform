import type { Inventory } from '@commerce/contracts';
import { ApiState, Empty } from '../../components/ApiState';
import { api, requireSession } from '../../lib/api';
import { when } from '../../lib/format';

interface AnomalyList {
  items: {
    id: string;
    ruleId: string;
    ruleVersion: string;
    severity: string;
    status: string;
    skuId: string | null;
    orderId: string | null;
    evidence: Record<string, unknown>;
    windowStart: string;
  }[];
}

export default async function InventoryPage() {
  const session = await requireSession();
  const anomalies = await api<AnomalyList>(session, '/v1/anomalies');
  const skuIds = anomalies.ok
    ? [...new Set(anomalies.body.items.map((a) => a.skuId).filter((s): s is string => s !== null))]
    : [];
  const balances = await Promise.all(
    skuIds.slice(0, 10).map((sku) => api<Inventory>(session, `/v1/inventory/${sku}`)),
  );
  return (
    <section>
      <h1>Inventario</h1>
      <p className="muted">
        Alertas del detector determinístico (reglas versionadas). Ningún hallazgo ajusta stock ni
        abre tickets; los ajustes los decide una persona fuera de esta consola.
      </p>
      <ApiState result={anomalies} what="las alertas de inventario" />
      {anomalies.ok && skuIds.length > 0 && (
        <>
          <h2>Balances actuales</h2>
          <table aria-label="Balances">
            <thead>
              <tr>
                <th scope="col">SKU</th>
                <th scope="col">Disponible</th>
                <th scope="col">On hand</th>
                <th scope="col">Reservado</th>
                <th scope="col">Stock de seguridad</th>
              </tr>
            </thead>
            <tbody>
              {balances.map((b, i) =>
                b.ok ? (
                  <tr key={skuIds[i]}>
                    <td>{b.body.sku_id}</td>
                    <td>{b.body.available}</td>
                    <td>{b.body.on_hand ?? '—'}</td>
                    <td>{b.body.reserved ?? '—'}</td>
                    <td>{b.body.safety_stock ?? '—'}</td>
                  </tr>
                ) : (
                  <tr key={skuIds[i]}>
                    <td>{skuIds[i]}</td>
                    <td colSpan={4}>No disponible</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </>
      )}
      {anomalies.ok && (
        <>
          <h2>Alertas</h2>
          {anomalies.body.items.length === 0 ? (
            <Empty>Sin alertas registradas.</Empty>
          ) : (
            <table aria-label="Alertas">
              <thead>
                <tr>
                  <th scope="col">Regla</th>
                  <th scope="col">Severidad</th>
                  <th scope="col">Estado</th>
                  <th scope="col">SKU</th>
                  <th scope="col">Evidencia</th>
                  <th scope="col">Ventana</th>
                </tr>
              </thead>
              <tbody>
                {anomalies.body.items.map((a) => (
                  <tr key={a.id}>
                    <td>
                      {a.ruleId} <span className="muted">({a.ruleVersion})</span>
                    </td>
                    <td>{a.severity}</td>
                    <td>{a.status}</td>
                    <td>{a.skuId ?? '—'}</td>
                    <td>
                      <code>{JSON.stringify(a.evidence)}</code>
                    </td>
                    <td>{when(a.windowStart)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
