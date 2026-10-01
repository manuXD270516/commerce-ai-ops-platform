import Link from 'next/link';
import { ApiState } from '../../../components/ApiState';
import { RunStream } from '../../../components/RunStream';
import { api, requireSession } from '../../../lib/api';
import { when } from '../../../lib/format';

interface RunView {
  id: string;
  status: string;
  intent: string | null;
  router_version: string | null;
  model_version: string | null;
  created_at: string;
  usage: { llmCalls: number; toolCalls: number; tokens: number; activeMs: number };
}

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;
  const run = await api<RunView>(session, `/v1/agent-runs/${encodeURIComponent(id)}`);
  return (
    <section>
      <h1>Run {id}</h1>
      <ApiState result={run} what="el run" />
      {run.ok && (
        <>
          <p className="muted">
            Creado {when(run.body.created_at)} · router {run.body.router_version ?? '—'} · redacción{' '}
            {run.body.model_version ?? '—'} · uso: {run.body.usage.toolCalls} tools,{' '}
            {run.body.usage.llmCalls} llamadas de modelo, {run.body.usage.tokens} tokens estimados
          </p>
          <RunStream
            runId={id}
            canAct={session.role === 'customer' || session.role === 'support'}
          />
          <p>
            <Link href="/runs">Nueva consulta</Link>
          </p>
        </>
      )}
    </section>
  );
}
