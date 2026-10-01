import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

interface Panel {
  readonly title: string;
  readonly note: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | number | null)[])[];
}

const PANELS: readonly { title: string; note: string; sql: string }[] = [
  {
    title: 'Runs por resultado (24 h)',
    note: 'Éxito por workflow: intent y outcome persistidos de cada run.',
    sql: `SELECT coalesce(intent, '—') AS intent, coalesce(outcome, status) AS outcome, count(*)::int AS runs
          FROM commerce.agent_runs WHERE created_at > now() - interval '24 hours'
          GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 20`,
  },
  {
    title: 'Duración activa de runs (24 h)',
    note: 'p50/p95 del tiempo activo medido por el executor; excluye espera humana.',
    sql: `SELECT count(*)::int AS runs,
                 round(percentile_cont(0.5) WITHIN GROUP (ORDER BY (usage->>'activeMs')::numeric))::int AS p50_ms,
                 round(percentile_cont(0.95) WITHIN GROUP (ORDER BY (usage->>'activeMs')::numeric))::int AS p95_ms,
                 round(percentile_cont(0.95) WITHIN GROUP (ORDER BY (usage->>'tokens')::numeric))::int AS p95_tokens_estimated
          FROM commerce.agent_runs WHERE created_at > now() - interval '24 hours' AND usage ? 'activeMs'`,
  },
  {
    title: 'Outbox',
    note: 'Eventos pendientes y antigüedad del más viejo (backlog > 5 min es alarma propuesta).',
    sql: `SELECT count(*)::int AS pending,
                 coalesce(round(extract(epoch FROM now() - min(created_at)))::int, 0) AS oldest_pending_s
          FROM commerce.outbox WHERE status = 'pending'`,
  },
  {
    title: 'Denegaciones (24 h)',
    note: 'Auditoría DENIED por acción: intentos fuera de permisos, tools rechazadas, solicitudes vencidas.',
    sql: `SELECT action, count(*)::int AS denied FROM commerce.audit_events
          WHERE outcome = 'DENIED' AND recorded_at > now() - interval '24 hours'
          GROUP BY 1 ORDER BY 2 DESC LIMIT 15`,
  },
  {
    title: 'Aprobaciones',
    note: 'Estado de las solicitudes y mediana del tiempo hasta la decisión humana.',
    sql: `SELECT status, count(*)::int AS requests,
                 round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM decided_at - created_at)))::int AS median_decision_s
          FROM commerce.action_requests GROUP BY 1 ORDER BY 2 DESC`,
  },
  {
    title: 'Frescura logística',
    note: 'Paquetes no entregados sin observación en más de 6 h (transportista simulado).',
    sql: `SELECT count(*) FILTER (WHERE status <> 'DELIVERED')::int AS in_flight,
                 count(*) FILTER (WHERE status <> 'DELIVERED' AND last_observed_at < now() - interval '6 hours')::int AS stale
          FROM commerce.shipments`,
  },
  {
    title: 'Corpus',
    note: 'Versiones publicadas/retiradas y última publicación (frescura del conocimiento).',
    sql: `SELECT status, count(*)::int AS versions, max(coalesce(published_at, created_at)) AS latest
          FROM commerce.document_versions GROUP BY 1 ORDER BY 1`,
  },
  {
    title: 'Alertas de inventario abiertas',
    note: 'Por regla y versión, del detector determinístico.',
    sql: `SELECT rule_id, rule_version, status, count(*)::int AS alerts
          FROM commerce.anomalies GROUP BY 1, 2, 3 ORDER BY 4 DESC`,
  },
];

const escape = (v: unknown) =>
  (v === null || v === undefined
    ? '—'
    : typeof v === 'string'
      ? v
      : typeof v === 'number' || typeof v === 'boolean'
        ? String(v)
        : JSON.stringify(v)
  ).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

/**
 * Static operations dashboard from the persisted data (all tenants, read as the table owner):
 * success by workflow, active time, outbox age, denials, approval latency, logistic and corpus
 * freshness. Written as Markdown and HTML next to the eval reports.
 */
export async function writeDashboard(migratorUrl: string, outDir: string): Promise<string> {
  const client = new pg.Client({ connectionString: migratorUrl });
  await client.connect();
  const panels: Panel[] = [];
  try {
    for (const p of PANELS) {
      const result = await client.query(p.sql);
      panels.push({
        title: p.title,
        note: p.note,
        columns: result.fields.map((f) => f.name),
        rows: result.rows.map((r: Record<string, unknown>) =>
          result.fields.map((f) => {
            const v = r[f.name];
            return v instanceof Date ? v.toISOString() : (v as string | number | null);
          }),
        ),
      });
    }
  } finally {
    await client.end();
  }
  const generated = new Date().toISOString();
  const md = [
    '# Dashboard operacional',
    '',
    `Generado ${generated} desde PostgreSQL local. Datos sintéticos; tokens estimados (SIMULATED).`,
    '',
    ...panels.flatMap((p) => [
      `## ${p.title}`,
      '',
      p.note,
      '',
      `| ${p.columns.join(' | ')} |`,
      `|${p.columns.map(() => '---').join('|')}|`,
      ...(p.rows.length
        ? p.rows.map((r) => `| ${r.map((v) => String(v ?? '—')).join(' | ')} |`)
        : [`| ${p.columns.map(() => '—').join(' | ')} |`]),
      '',
    ]),
  ].join('\n');
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Dashboard operacional</title>
<style>body{font-family:system-ui,sans-serif;max-width:70rem;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse;margin:.5rem 0 1.5rem}td,th{border:1px solid #ccc;padding:.3rem .6rem;text-align:left}.muted{color:#555}</style></head><body>
<h1>Dashboard operacional</h1><p class="muted">Generado ${escape(generated)} desde PostgreSQL local. Datos sintéticos; tokens estimados (SIMULATED).</p>
${panels
  .map(
    (p) =>
      `<section><h2>${escape(p.title)}</h2><p class="muted">${escape(p.note)}</p><table><thead><tr>${p.columns.map((c) => `<th>${escape(c)}</th>`).join('')}</tr></thead><tbody>${p.rows.map((r) => `<tr>${r.map((v) => `<td>${escape(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></section>`,
  )
  .join('\n')}
</body></html>
`;
  await mkdir(outDir, { recursive: true });
  const stamp = generated.replace(/[-:]/g, '').replace(/\..+$/, '');
  await writeFile(join(outDir, `ops-dashboard-${stamp}.md`), md);
  const path = join(outDir, `ops-dashboard-${stamp}.html`);
  await writeFile(path, html);
  return path;
}
