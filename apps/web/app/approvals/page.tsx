import { ApiState, Empty } from '../../components/ApiState';
import { DecisionButtons } from '../../components/DecisionButtons';
import { api, requireSession } from '../../lib/api';
import { STATUS_LABEL, when } from '../../lib/format';

interface RequestView {
  id: string;
  resource: { type: string; id: string };
  effect: string;
  canonical_args: Record<string, unknown>;
  canonical_args_hash: string;
  expected_version: number;
  policy_version: string;
  status: string;
  requester: string;
  created_at: string;
  expires_at: string;
  current_order: { status: string; version: number } | null;
  stale: boolean;
  decision: { approverSubjectId: string; decision: string; decidedAt: string } | null;
}

export default async function ApprovalsPage() {
  const session = await requireSession();
  const result = await api<{ items: RequestView[] }>(session, '/v1/action-requests');
  const approver = session.role === 'approver';
  return (
    <section>
      <h1>{approver ? 'Bandeja de aprobación' : 'Mis solicitudes'}</h1>
      <p className="muted">
        {approver
          ? 'Revisás solicitudes de otros usuarios. El servidor vuelve a validar versión, vigencia y payload al decidir y al ejecutar.'
          : 'Solicitudes que confirmaste. Otra persona con rol approver las decide.'}
      </p>
      <ApiState result={result} what="las solicitudes" />
      {result.ok && result.body.items.length === 0 && <Empty>No hay solicitudes.</Empty>}
      {result.ok &&
        result.body.items.map((r) => (
          <article
            key={r.id}
            className="card"
            aria-label={`Solicitud ${r.id}`}
            data-request-id={r.id}
          >
            <h2>
              {STATUS_LABEL[r.status] ?? r.status} — orden {r.resource.id}
            </h2>
            <dl>
              <dt>Efecto exacto</dt>
              <dd>{r.effect}</dd>
              <dt>Argumentos canónicos</dt>
              <dd>
                <code>{JSON.stringify(r.canonical_args)}</code>
              </dd>
              <dt>Versión esperada / actual</dt>
              <dd>
                {r.expected_version} / {r.current_order?.version ?? '—'} (
                {r.current_order?.status ?? '—'})
              </dd>
              <dt>Política</dt>
              <dd>{r.policy_version}</dd>
              <dt>Solicitante</dt>
              <dd>{r.requester}</dd>
              <dt>Vence</dt>
              <dd>{when(r.expires_at)}</dd>
              {r.decision && (
                <>
                  <dt>Decisión</dt>
                  <dd>
                    {r.decision.decision} por {r.decision.approverSubjectId} (
                    {when(r.decision.decidedAt)})
                  </dd>
                </>
              )}
            </dl>
            {r.stale && r.status === 'PENDING' && (
              <p className="notice warn" role="status">
                La orden cambió desde que se pidió: el servidor rechazará la aprobación.
              </p>
            )}
            {approver && r.status === 'PENDING' && r.requester !== session.subjectId && (
              <DecisionButtons requestId={r.id} />
            )}
          </article>
        ))}
    </section>
  );
}
