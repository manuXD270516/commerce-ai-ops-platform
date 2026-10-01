'use client';

import { useState } from 'react';

/**
 * Approve or reject. The UI never assumes success: it shows the status the server returned, and a
 * conflict (e.g. the order changed after the screen was opened) is shown as such.
 */
export function DecisionButtons({ requestId }: { requestId: string }) {
  const [state, setState] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function decide(decision: 'APPROVED' | 'REJECTED') {
    setBusy(true);
    const res = await fetch(`/api/approvals/${requestId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision }),
    }).catch(() => undefined);
    const body = res
      ? ((await res.json()) as { status?: string; code?: string; message?: string })
      : {};
    setBusy(false);
    if (res?.ok) {
      setState({
        kind: 'ok',
        text:
          decision === 'APPROVED'
            ? 'Aprobada. La ejecución la realiza el run del solicitante y el servidor vuelve a validar todo antes de confirmar; todavía no se muestra como ejecutada.'
            : 'Rechazada. No habrá ningún cambio en la orden.',
      });
    } else {
      setState({
        kind: 'err',
        text: `${body.code ?? 'Error'}: ${body.message ?? 'el servidor rechazó la decisión'}. No se ejecutó nada.`,
      });
    }
  }

  return (
    <div>
      {state?.kind !== 'ok' && (
        <>
          <button type="button" onClick={() => void decide('APPROVED')} disabled={busy}>
            Aprobar
          </button>{' '}
          <button
            type="button"
            className="secondary"
            onClick={() => void decide('REJECTED')}
            disabled={busy}
          >
            Rechazar
          </button>
        </>
      )}
      {state && (
        <p className={`notice ${state.kind}`} role="status" data-decision-result={state.kind}>
          {state.text}
        </p>
      )}
    </div>
  );
}
