import Link from 'next/link';
import type { Order, ShippingStatus } from '@commerce/contracts';
import { ApiState } from '../../../components/ApiState';
import { api, requireSession } from '../../../lib/api';
import { usd, when } from '../../../lib/format';

const REASONS: Record<string, string> = {
  shipment_lost: 'paquete perdido (LOST)',
  delivered_disputed: 'entrega en disputa',
  delay_over_48h: 'más de 48 h de atraso',
};

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;
  const [order, shipping] = await Promise.all([
    api<Order>(session, `/v1/orders/${encodeURIComponent(id)}`),
    api<ShippingStatus>(session, `/v1/orders/${encodeURIComponent(id)}/shipping`),
  ]);
  return (
    <section>
      <h1>Orden {id}</h1>
      <ApiState result={order} what="la orden" />
      {order.ok && (
        <div className="card">
          <p>
            Estado: <strong>{order.body.status}</strong> · versión {order.body.version} · total{' '}
            {usd(order.body.total_minor)}
          </p>
          <ul>
            {order.body.items.map((i) => (
              <li key={i.id}>
                {i.quantity} × {i.title_snapshot} ({usd(i.unit_price_minor)}, precio de compra)
              </li>
            ))}
          </ul>
          <p className="muted">Observado: {when(order.body.observed_at)}</p>
        </div>
      )}
      {order.ok && (
        <>
          <h2>Timeline de envío</h2>
          <ApiState result={shipping} what="el envío" />
          {shipping.ok && shipping.body.escalation?.required && (
            <p className="notice warn" role="status">
              Escalamiento requerido ({shipping.body.escalation.rule_version}):{' '}
              {shipping.body.escalation.reasons.map((r) => REASONS[r] ?? r).join(', ')}.
            </p>
          )}
          {shipping.ok && shipping.body.shipments.length === 0 && (
            <p className="notice" data-state="empty">
              Todavía no hay paquetes despachados.
            </p>
          )}
          {shipping.ok && (
            <ol className="timeline" aria-label="Paquetes">
              {shipping.body.shipments.map((s) => (
                <li key={s.id}>
                  <strong>{s.tracking_ref}</strong> — {s.status}{' '}
                  <span className="badge sim">Envío simulado</span>{' '}
                  {s.stale && (
                    <span className="badge warn">
                      Tracking desactualizado: no se confirma fecha de entrega
                    </span>
                  )}
                  <div className="muted">
                    Última observación: {when(s.last_observed_at)} · fecha prometida:{' '}
                    {when(s.estimated_delivery_at)}
                    {typeof s.delay_hours === 'number'
                      ? ` · atraso ${String(s.delay_hours)} h`
                      : ''}
                  </div>
                  <div>
                    Líneas:{' '}
                    {s.items
                      .map((it) => {
                        const line = order.body.items.find((x) => x.id === it.order_item_id);
                        return `${String(it.quantity)} × ${line?.title_snapshot ?? it.order_item_id}`;
                      })
                      .join(', ')}
                  </div>
                </li>
              ))}
            </ol>
          )}
          <p>
            <Link href={`/runs?order=${encodeURIComponent(id)}`}>Investigar con el asistente</Link>
          </p>
        </>
      )}
    </section>
  );
}
