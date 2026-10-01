'use client';

import { useEffect, useRef, useState } from 'react';

interface Evidence {
  kind: string;
  ref: string;
  version: string;
  observedAt: string;
  source: string;
}

interface Finding {
  specialist: string;
  status: string;
  facts: { text: string; evidence: Evidence }[];
  inferences: string[];
  uncertainty: string[];
  next_steps: string[];
  escalation?: { required: boolean; ruleVersion: string; reasons: string[] };
}

interface Proposal {
  tool: string;
  order_id: string;
  action: string;
  reason_code: string;
  expected_version: number;
}

interface RunEventData {
  type: string;
  seq: number;
  status?: string;
  outcome?: string;
  partial?: boolean;
  summary?: string;
  findings?: Finding[];
  proposal?: Proposal | null;
  provider?: { id: string; mode: string };
}

type Connection = 'connecting' | 'open' | 'reconnecting' | 'closed';

const STATUS: Record<string, string> = {
  QUEUED: 'En cola',
  RUNNING: 'Ejecutando…',
  WAITING_HUMAN: 'Esperando decisión humana',
  COMPLETED: 'Completado',
  FAILED: 'Falló',
  CANCELLED: 'Run detenido',
  CANCELLING: 'Deteniendo…',
};

const OUTCOME: Record<string, string> = {
  ANSWERED: 'Respuesta con evidencia',
  CLARIFICATION_REQUESTED: 'Necesito una aclaración',
  REFUSED: 'Fuera de alcance',
  BUDGET_EXCEEDED: 'Respuesta parcial (presupuesto agotado)',
  ACCESS_REVOKED: 'Acceso revocado: sin acciones',
  ACTION_EXECUTED: 'Cancelación solicitada',
  ACTION_REJECTED: 'Solicitud no ejecutada',
  ACTION_FAILED: 'La solicitud no pudo ejecutarse',
  CANCELLED: 'Run detenido',
  ERROR: 'Error interno',
};

/**
 * Follows a run through server-sent events. The browser's EventSource reconnects on its own with
 * Last-Event-ID, so a dropped connection replays only what was missed; a page reload rebuilds the
 * view from the persisted events. Nothing here starts or retries a run.
 */
export function RunStream({ runId, canAct }: { runId: string; canAct: boolean }) {
  const [events, setEvents] = useState<RunEventData[]>([]);
  const [connection, setConnection] = useState<Connection>('connecting');
  const seen = useRef(new Set<number>());

  useEffect(() => {
    const source = new EventSource(`/api/runs/${runId}/events`);
    const onEvent = (raw: MessageEvent<string>) => {
      const data = JSON.parse(raw.data) as RunEventData;
      if (seen.current.has(data.seq)) return;
      seen.current.add(data.seq);
      setEvents((prev) => [...prev, data]);
      if (data.type === 'completed') {
        source.close();
        setConnection('closed');
      }
    };
    for (const type of ['status', 'approval_required', 'completed', 'message']) {
      source.addEventListener(type, onEvent as EventListener);
    }
    source.onopen = () => {
      setConnection('open');
    };
    source.onerror = () => {
      setConnection(source.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting');
    };
    return () => {
      source.close();
    };
  }, [runId]);

  const completed = events.find((e) => e.type === 'completed');
  const approval = [...events].reverse().find((e) => e.type === 'approval_required');
  const lastStatus = [...events].reverse().find((e) => e.status)?.status ?? 'QUEUED';
  const status = completed?.status ?? lastStatus;

  return (
    <div>
      <p role="status" aria-live="polite" data-run-status={status}>
        Estado: <strong>{STATUS[status] ?? status}</strong>
        {connection === 'reconnecting' && (
          <span className="badge warn">
            {' '}
            Conexión interrumpida: reconectando sin reiniciar el run…
          </span>
        )}
        {connection === 'connecting' && <span className="muted"> (conectando…)</span>}
      </p>
      {status === 'RUNNING' || status === 'QUEUED' ? (
        <p className="muted" data-state="loading">
          Reuniendo hechos de la base de datos…
        </p>
      ) : null}
      {approval && !completed && (
        <ApprovalProposal runId={runId} event={approval} canAct={canAct} />
      )}
      {completed && <Completed runId={runId} event={completed} canAct={canAct} />}
    </div>
  );
}

function Findings({ findings }: { findings: Finding[] }) {
  return (
    <>
      {findings.map((f, i) => (
        <section
          key={`${f.specialist}-${String(i)}`}
          className="card"
          aria-label={`Hallazgos ${f.specialist}`}
        >
          <h3>
            {f.specialist === 'order'
              ? 'Orden'
              : f.specialist === 'recommendation'
                ? 'Recomendación'
                : 'Inventario'}{' '}
            {f.status === 'partial' && <span className="badge warn">Parcial / degradado</span>}
          </h3>
          {f.facts.length > 0 && (
            <>
              <h4>Hechos</h4>
              <ul>
                {f.facts.map((fact, j) => (
                  <li key={j}>
                    {fact.text}{' '}
                    <span className="muted">
                      [{fact.evidence.kind}: {fact.evidence.ref} · {fact.evidence.version}]
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {f.inferences.length > 0 && (
            <>
              <h4>Inferencias</h4>
              <ul>
                {f.inferences.map((t, j) => (
                  <li key={j}>{t}</li>
                ))}
              </ul>
            </>
          )}
          {f.uncertainty.length > 0 && (
            <>
              <h4>Incertidumbre</h4>
              <ul>
                {f.uncertainty.map((t, j) => (
                  <li key={j}>{t}</li>
                ))}
              </ul>
            </>
          )}
          {f.escalation?.required && (
            <p className="notice warn">
              Escalamiento ({f.escalation.ruleVersion}): {f.escalation.reasons.join(', ')}
            </p>
          )}
          {f.next_steps.length > 0 && (
            <>
              <h4>Siguientes pasos</h4>
              <ul>
                {f.next_steps.map((t, j) => (
                  <li key={j}>{t}</li>
                ))}
              </ul>
            </>
          )}
        </section>
      ))}
    </>
  );
}

function ApprovalProposal({
  runId,
  event,
  canAct,
}: {
  runId: string;
  event: RunEventData;
  canAct: boolean;
}) {
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const proposal = event.proposal;
  async function confirm() {
    if (!proposal) return;
    setBusy(true);
    const res = await fetch('/api/action-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `confirm-${runId}` },
      body: JSON.stringify({
        order_id: proposal.order_id,
        reason_code: proposal.reason_code,
        expected_version: proposal.expected_version,
        run_id: runId,
      }),
    }).catch(() => undefined);
    const body = res
      ? ((await res.json()) as { status?: string; code?: string; message?: string })
      : {};
    setBusy(false);
    setResult(
      res?.ok
        ? {
            ok: true,
            text: 'Solicitud registrada: pendiente de aprobación por otra persona. Nada se ejecutó todavía.',
          }
        : { ok: false, text: `${body.code ?? 'Error'}: ${body.message ?? 'no se pudo registrar'}` },
    );
  }
  return (
    <section className="card" aria-label="Propuesta de acción">
      <h3>Propuesta: solicitar cancelación</h3>
      {proposal && (
        <dl>
          <dt>Orden</dt>
          <dd>{proposal.order_id}</dd>
          <dt>Efecto</dt>
          <dd>Pasa a CANCELLATION_REQUESTED; no cancela con el transportista ni reembolsa.</dd>
          <dt>Motivo</dt>
          <dd>{proposal.reason_code}</dd>
          <dt>Versión esperada</dt>
          <dd>{proposal.expected_version}</dd>
        </dl>
      )}
      {event.findings && <Findings findings={event.findings} />}
      {canAct && !result?.ok && (
        <button type="button" onClick={() => void confirm()} disabled={busy}>
          Confirmar solicitud de cancelación
        </button>
      )}
      {result && (
        <p className={`notice ${result.ok ? 'ok' : 'err'}`} role="status">
          {result.text}
        </p>
      )}
    </section>
  );
}

function Completed({
  runId,
  event,
  canAct,
}: {
  runId: string;
  event: RunEventData;
  canAct: boolean;
}) {
  const [ticket, setTicket] = useState<{ ok: boolean; text: string } | null>(null);
  const order = event.findings?.find((f) => f.specialist === 'order');
  const orderRef = order?.facts
    .find((f) => f.evidence.kind === 'order')
    ?.evidence.ref.replace('order:', '');
  const offerTicket = canAct && order?.next_steps.some((s) => s.includes('ticket'));
  async function createTicket() {
    const res = await fetch('/api/tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `ticket-${runId}` },
      body: JSON.stringify({
        order_id: orderRef,
        category: order?.escalation?.reasons.includes('shipment_lost')
          ? 'lost_package'
          : 'delivery_delay',
        // No ids or digits in free text: the order travels in order_id and evidence_refs.
        summary: `Seguimiento de envío pedido desde el asistente: ${order?.escalation?.reasons.length ? order.escalation.reasons.join(', ') : 'revisión de envío'}`,
        evidence_refs: orderRef ? [{ kind: 'order', id: orderRef }] : [],
      }),
    }).catch(() => undefined);
    const body = res
      ? ((await res.json()) as { id?: string; code?: string; message?: string })
      : {};
    setTicket(
      res?.ok
        ? { ok: true, text: `Ticket creado (${body.id ?? ''}) con tu confirmación.` }
        : { ok: false, text: `${body.code ?? 'Error'}: ${body.message ?? 'no se creó el ticket'}` },
    );
  }
  return (
    <section aria-label="Resultado">
      <p className={`notice ${event.partial ? 'warn' : 'ok'}`} data-outcome={event.outcome}>
        {OUTCOME[event.outcome ?? ''] ?? event.outcome}
        {event.provider?.mode === 'simulated' && (
          <span className="badge sim"> Redacción por plantilla (SIMULATED)</span>
        )}
      </p>
      {event.findings && event.findings.length > 0 ? <Findings findings={event.findings} /> : null}
      <h3>Respuesta</h3>
      <p style={{ whiteSpace: 'pre-wrap' }} data-testid="run-summary">
        {event.summary}
      </p>
      {offerTicket && !ticket?.ok && (
        <button type="button" className="secondary" onClick={() => void createTicket()}>
          Crear ticket de soporte con esta evidencia
        </button>
      )}
      {ticket && (
        <p className={`notice ${ticket.ok ? 'ok' : 'err'}`} role="status">
          {ticket.text}
        </p>
      )}
    </section>
  );
}
