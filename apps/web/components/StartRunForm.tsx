'use client';

import { useRouter } from 'next/navigation';
import { useState, type SyntheticEvent } from 'react';

export function StartRunForm({ initialMessage }: { initialMessage: string }) {
  const router = useRouter();
  const [message, setMessage] = useState(initialMessage);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      const body = (await res.json()) as { id?: string; code?: string; message?: string };
      if (res.status !== 202 || !body.id) {
        setError(
          `${body.code ?? `HTTP ${String(res.status)}`}: ${body.message ?? 'no se pudo iniciar'}`,
        );
        return;
      }
      router.push(`/runs/${body.id}`);
    } catch {
      setError('No se pudo contactar a la consola. Reintentá.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} aria-label="Nueva consulta al asistente">
      <label>
        Consulta
        <textarea
          name="message"
          rows={3}
          cols={70}
          required
          maxLength={2000}
          value={message}
          onChange={(e) => {
            setMessage(e.target.value);
          }}
        />
      </label>
      <p>
        <button type="submit" disabled={busy || message.trim() === ''}>
          {busy ? 'Enviando…' : 'Enviar'}
        </button>
      </p>
      {error && (
        <p className="notice err" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
