import { cookies } from 'next/headers';
import { apiGet, sessionFromCookie } from '../../lib/session';

export default async function ApprovalsPage() {
  const session = sessionFromCookie((await cookies()).toString());
  if (session.role !== 'approver') {
    return (
      <section>
        <h1>Aprobaciones</h1>
        <p>Sólo el rol approver ve la bandeja. Inventory y customer no.</p>
      </section>
    );
  }
  await apiGet(session, '/v1/anomalies');
  return (
    <section>
      <h1>Bandeja de aprobación</h1>
      <p>
        El efecto exacto, versión y expiración los confirma el servidor. Si la orden cambió se
        muestra CONFLICT y no se presenta como ejecutada. Una cancelación aprobada se etiqueta
        “cancelación solicitada”.
      </p>
    </section>
  );
}
