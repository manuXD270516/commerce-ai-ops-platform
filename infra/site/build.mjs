// Builds the public static evidence site (GitHub Pages) from the committed, archived evidence of
// the OpenSpec changes: release gates (M10), production-like demo and recovery drills, the local
// Kubernetes validation and the AKS readiness (M11). No backend, no secrets, no PII: only selected
// fields of the reports are rendered, and the output is scanned before it is written.
// Usage: node infra/site/build.mjs [outDir]   (default: site/)   Env: SITE_CI_RUN_URL (optional)
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPrivateData } from './guard.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = process.argv[2] ? join(process.cwd(), process.argv[2]) : join(root, 'site');
const archive = join(root, 'openspec', 'changes', 'archive');
const REPO = 'https://github.com/manuXD270516/commerce-ai-ops-platform';
const ciRunUrl = process.env.SITE_CI_RUN_URL ?? '';

function evidence(change, prefix) {
  const dir = join(archive, change, 'evidence');
  const file = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort()
    .at(-1);
  if (!file) throw new Error(`no ${prefix}*.json in ${change}/evidence`);
  return { file, data: JSON.parse(readFileSync(join(dir, file), 'utf8')) };
}

const esc = (v) =>
  String(v ?? '—').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const num = (v, unit) => {
  if (typeof v !== 'number') return esc(v);
  if (unit === 'ms') return v >= 10_000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
  if (unit === 'ratio') return v.toFixed(3).replace(/\.?0+$/, '') || '0';
  return String(v);
};
const badge = (text, kind) => `<span class="badge ${kind}">${esc(text)}</span>`;

const M10 = '2026-10-01-add-evaluation-gates';
const M11 = '2026-10-01-add-cloud-deployment-demo';
const release = evidence(M10, 'release-gates-').data;
const demo = evidence(M11, 'm11-demo-2').data;
const demoK8s = evidence(M11, 'm11-demo-k8s-').data;
const drill = evidence(M11, 'm11-recovery-drill-').data;
const k8s = evidence(M11, 'm11-k8s-local-').data;
const load = evidence(M10, 'load-2').data;

const checksOf = (report) => report.results.find((r) => r.metric.endsWith('_checks_passed'));
const timingsOf = (report) => report.results.filter((r) => r.unit === 'ms');
const gatesPassed = release.gates.filter((g) => g.passed).length;
const securityFailed = release.gates.filter((g) => g.security && !g.passed).length;

const LABELS = {
  drill_redis_down_run_accept_ms: 'Accept a run while Redis is down',
  drill_redis_outage_ms: 'Redis outage (drill)',
  drill_redis_recovery_ms: 'Rebuild work after Redis returns',
  drill_restart_to_ready_ms: 'Restart api + worker to ready',
  drill_rollback_detect_ms: 'Detect a broken release (health gate)',
  drill_rollback_restore_ms: 'Roll back to the previous immutable tag',
  drill_backup_dump_ms: 'Backup (pg_dump)',
  drill_restore_instance_ready_ms: 'Isolated restore instance ready',
  drill_restore_pg_restore_ms: 'pg_restore',
  drill_restore_total_ms: 'Restore end to end, verified',
  demo_case1_order_status_ms: 'Case 1: order status with evidence',
  demo_case2_recommendation_ms: 'Case 2: recommendation within budget',
  demo_case3_inventory_ms: 'Case 3: inventory discrepancy explained',
  demo_approval_end_to_end_ms: 'Cancellation with second-person approval',
  k8s_cluster_ready_ms: 'k3s cluster ready',
  k8s_image_import_ms: 'Import app images',
  k8s_deploy_to_ready_ms: 'Migration job + apps ready',
  k8s_rollout_undo_ms: 'kubectl rollout undo',
};

const gateRows = release.gates
  .map((g) => {
    const exception = !g.passed && !g.security;
    return `<tr class="${g.passed ? '' : 'fail'}">
  <td><code>${esc(g.metric)}</code>${g.security ? ' ' + badge('security', 'sec') : ''}</td>
  <td>${esc(g.threshold)}</td>
  <td class="num">${num(g.value, g.unit)}${['ratio', 'count', 'ms'].includes(g.unit) ? '' : ` ${esc(g.unit)}`}</td>
  <td class="num">${esc(g.n)}</td>
  <td>${badge(g.status, g.status === 'MEASURED' ? 'measured' : 'simulated')}</td>
  <td>${g.passed ? badge('pass', 'ok') : badge(exception ? 'fail · accepted exception' : 'fail', 'bad')}</td>
</tr>`;
  })
  .join('\n');

const timingTable = (reports) =>
  `<table><thead><tr><th>Operation</th><th class="num">Observed</th></tr></thead><tbody>${reports
    .flatMap(timingsOf)
    .map(
      (t) =>
        `<tr><td>${esc(LABELS[t.metric] ?? t.metric)}</td><td class="num">${num(t.value, 'ms')}</td></tr>`,
    )
    .join('')}</tbody></table>`;

const loadRows = load.results
  .map(
    (r) =>
      `<tr><td><code>${esc(r.metric)}</code></td><td class="num">${num(r.value, r.unit)}${r.unit === 'ms' ? '' : ` ${esc(r.unit)}`}</td><td class="num">${esc(r.denominator)}</td><td>${badge(r.status, r.status === 'MEASURED' ? 'measured' : 'simulated')}</td></tr>`,
  )
  .join('');

const summaryCard = (title, value, note, kind = '') =>
  `<div class="card ${kind}"><div class="k">${esc(title)}</div><div class="v">${value}</div><div class="n">${note}</div></div>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Commerce AI Ops — evidence</title>
<meta name="description" content="Static evidence of commerce-ai-ops-platform: evaluation gates, production-like demo, recovery drills and AKS deployment readiness. Synthetic data only.">
<style>
:root{--bg:#fbfbfa;--fg:#1c1d1f;--muted:#5d6168;--line:#e3e4e6;--card:#fff;--accent:#2f5bd3;--ok:#1b7a3d;--okbg:#e5f4ea;--bad:#a8261b;--badbg:#fbe9e7;--sim:#7a5a00;--simbg:#fbf1d6;--sec:#5b2ca0;--secbg:#efe7fb}
@media (prefers-color-scheme:dark){:root{--bg:#141517;--fg:#e8e9eb;--muted:#a2a6ad;--line:#2c2e32;--card:#1c1d20;--accent:#8aa8ff;--ok:#7fd59a;--okbg:#17301f;--bad:#ff9b8f;--badbg:#3a1a17;--sim:#f0cf75;--simbg:#33290c;--sec:#c9a7ff;--secbg:#2a1f3d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1060px;margin:0 auto;padding:32px 16px 64px}header p{color:var(--muted);max-width:760px}
h1{font-size:2rem;margin:0 0 .4rem}h2{margin:2.6rem 0 .8rem;font-size:1.35rem}h3{margin:1.6rem 0 .6rem;font-size:1.05rem}
a{color:var(--accent)}code{font:13px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin:1.4rem 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}.card .k{color:var(--muted);font-size:.85rem}
.card .v{font-size:1.5rem;font-weight:650;margin:.2rem 0}.card .n{color:var(--muted);font-size:.85rem}
.card.warn{border-color:var(--sim)}.card.good{border-color:var(--ok)}
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-size:.92rem}th,td{padding:8px 12px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-weight:600;color:var(--muted);background:var(--bg)}tr:last-child td{border-bottom:0}td.num,th.num{text-align:right;white-space:nowrap}
tr.fail td{background:var(--badbg)}
.badge{display:inline-block;font-size:.75rem;padding:1px 8px;border-radius:999px;white-space:nowrap}
.ok{background:var(--okbg);color:var(--ok)}.bad{background:var(--badbg);color:var(--bad)}
.measured{background:var(--okbg);color:var(--ok)}.simulated{background:var(--simbg);color:var(--sim)}.sec{background:var(--secbg);color:var(--sec)}
.note{border-left:3px solid var(--sim);background:var(--card);padding:10px 14px;border-radius:0 8px 8px 0;margin:1rem 0}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}
ul{padding-left:1.2rem}li{margin:.25rem 0}svg{width:100%;height:auto;max-width:860px}
svg text{font:13px system-ui,sans-serif;fill:var(--fg)}svg .box{fill:var(--card);stroke:var(--line);stroke-width:1.5}
svg .zone{fill:none;stroke:var(--muted);stroke-dasharray:5 4}svg .edge{stroke:var(--muted);stroke-width:1.5;fill:none;marker-end:url(#a)}
footer{margin-top:3rem;color:var(--muted);font-size:.85rem}
</style>
</head>
<body><main>
<header>
<h1>Commerce AI Ops — evidence</h1>
<p>An e-commerce operations platform with domain APIs, hybrid retrieval, AI-assisted workflows and auditable MCP actions. This page shows the measured evidence from the repository. All data is synthetic, there is no backend behind this page, and no third-party model is called: the AI provider is a deterministic template, labelled <strong>SIMULATED</strong> wherever it matters.</p>
<p><a href="${REPO}">Source on GitHub</a> · <a href="${REPO}/blob/main/README.md">README</a> · <a href="${REPO}/blob/main/docs/runbook.md">Runbook</a>${ciRunUrl ? ` · <a href="${esc(ciRunUrl)}">CI run that published this page</a>` : ''}</p>
</header>

<div class="cards">
${summaryCard('Release gates (holdout ×3)', `${gatesPassed}/${release.gates.length}`, `${securityFailed === 0 ? 'no security gate fails' : `${securityFailed} security gates fail`}; 2 quality gates fail (accepted exceptions)`, 'warn')}
${summaryCard('Production-like demo', `${checksOf(demo).numerator}/${checksOf(demo).denominator}`, '3 cases, second-person approval and replay over TLS', 'good')}
${summaryCard('Recovery drills', `${checksOf(drill).numerator}/${checksOf(drill).denominator}`, 'Redis loss, restart, rollback, isolated restore', 'good')}
${summaryCard('Kubernetes (k3s) validation', `${checksOf(k8s).numerator}/${checksOf(k8s).denominator}`, `same manifests as AKS; demo ${checksOf(demoK8s).numerator}/${checksOf(demoK8s).denominator} through the ingress`, 'good')}
${summaryCard('AKS deployment', 'Ready', 'configuration only: needs a paid Azure subscription', 'warn')}
</div>

<h2>Architecture</h2>
<svg viewBox="0 0 860 300" role="img" aria-label="Edge routes to console and API; worker and MCP server run in the private network with PostgreSQL and Redis">
<defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>
<rect class="box" x="10" y="120" width="120" height="54" rx="8"/><text x="70" y="145" text-anchor="middle">TLS edge</text><text x="70" y="163" text-anchor="middle" font-size="11">ingress / Caddy</text>
<rect class="box" x="190" y="60" width="140" height="54" rx="8"/><text x="260" y="85" text-anchor="middle">Console</text><text x="260" y="103" text-anchor="middle" font-size="11">Next.js BFF</text>
<rect class="box" x="190" y="180" width="140" height="54" rx="8"/><text x="260" y="205" text-anchor="middle">API</text><text x="260" y="223" text-anchor="middle" font-size="11">NestJS, /v1</text>
<rect class="zone" x="380" y="20" width="470" height="270" rx="12"/><text x="395" y="42" font-size="12">private data network (NetworkPolicy / internal)</text>
<rect class="box" x="400" y="58" width="150" height="54" rx="8"/><text x="475" y="83" text-anchor="middle">Worker</text><text x="475" y="101" text-anchor="middle" font-size="11">LangGraph runs</text>
<rect class="box" x="400" y="226" width="150" height="54" rx="8"/><text x="475" y="251" text-anchor="middle">MCP server</text><text x="475" y="269" text-anchor="middle" font-size="11">8 tools, scoped</text>
<rect class="box" x="640" y="58" width="190" height="54" rx="8"/><text x="735" y="83" text-anchor="middle">PostgreSQL + pgvector</text><text x="735" y="101" text-anchor="middle" font-size="11">source of truth, RLS</text>
<rect class="box" x="640" y="150" width="190" height="54" rx="8"/><text x="735" y="175" text-anchor="middle">Redis</text><text x="735" y="193" text-anchor="middle" font-size="11">coordination only</text>
<path class="edge" d="M130 140 L188 92"/><path class="edge" d="M130 155 L188 200"/><path class="edge" d="M260 114 L260 178"/>
<path class="edge" d="M330 195 L638 100"/><path class="edge" d="M330 212 L638 182"/><path class="edge" d="M550 80 L638 80"/><path class="edge" d="M550 100 L638 160"/><path class="edge" d="M550 240 L638 108"/>
</svg>
<ul>
<li>Every privileged action goes through one enforcement point (schema, scopes, consent, audit) and needs a second person's approval, consumed atomically and only once.</li>
<li>Agent runs are durable in PostgreSQL (checkpoints, events, leases); losing Redis loses no decision and duplicates no effect.</li>
<li>Tenant isolation by row-level security; the console never holds database credentials.</li>
</ul>

<h2>Evaluation: release gates</h2>
<p>Generated ${esc(release.generated_at.slice(0, 10))} on the sealed holdouts (ops-eval 1.0.0: 120 cases; router and knowledge holdouts), three repetitions. Verdict: ${badge(release.verdict, release.verdict === 'PASS' ? 'ok' : 'bad')}</p>
<div class="note"><strong>Accepted exceptions (repository owner, 2026-10-01).</strong> Intent routing macro-F1 0.936 (gate 0.95) and retrieval MRR@5 0.792 (gate 0.8) are kept as measured, with the thresholds unchanged; the next step is a new tuning cycle on dev with a fresh holdout. Labels are single-author: two-reviewer adjudication is an open follow-up. No exception applies to security gates.</div>
<div class="table-wrap"><table><thead><tr><th>Gate</th><th>Threshold</th><th class="num">Value</th><th class="num">n</th><th>Status</th><th>Result</th></tr></thead><tbody>
${gateRows}
</tbody></table></div>
<p><small>MEASURED: observed on the real code path against PostgreSQL. SIMULATED: orchestration with the template provider; it does not certify any real model's latency, tokens or cost.</small></p>

<h3>Load (20 minutes, 10 sessions, one workstation)</h3>
<div class="table-wrap"><table><thead><tr><th>Metric</th><th class="num">Value</th><th class="num">n</th><th>Status</th></tr></thead><tbody>${loadRows}</tbody></table></div>

<h2>Production-like stack and recovery drills</h2>
<p>Immutable images, TLS at the edge, file-mounted secrets and a private data network, run with Docker Compose. Single observations on one workstation, not an SLA.</p>
<div class="grid2">
<div><h3>Demo over TLS (${checksOf(demo).numerator}/${checksOf(demo).denominator})</h3><div class="table-wrap">${timingTable([demo])}</div></div>
<div><h3>Recovery drills (${checksOf(drill).numerator}/${checksOf(drill).denominator})</h3><div class="table-wrap">${timingTable([drill])}</div></div>
</div>
<ul>
<li><strong>Redis loss:</strong> the API still accepts runs and approvals; write rate limits hold (enforced in PostgreSQL); queued and approved work is rebuilt from PostgreSQL with exactly one execution.</li>
<li><strong>Rollback:</strong> a deliberately broken image is rejected by the health gate and the previous immutable tag is restored.</li>
<li><strong>Restore:</strong> a dump restored into an isolated database matches table counts, run states, the last audit event, foreign keys and row-level-security policies.</li>
</ul>

<h2>Kubernetes and AKS readiness</h2>
<div class="grid2">
<div>
<h3>Validated locally, at no cost</h3>
<ul>
<li>Terraform (azurerm 4.x): <code>fmt</code> and <code>validate</code> pass.</li>
<li>Kustomize manifests render and pass <code>kubeconform -strict</code> (Kubernetes 1.33, CRD schemas).</li>
<li>The same manifests on k3s in Docker: migration job, probes, network policy (the console cannot reach the database), the full demo through the ingress, a broken rollout contained and undone, migrations re-run without losing data.</li>
</ul>
<div class="table-wrap">${timingTable([k8s])}</div>
</div>
<div>
<h3>AKS: ready, needs a paid Azure subscription</h3>
<ul>
<li>AKS with workload identity, Key Vault secrets via the CSI driver, app-routing ingress with TLS, Cilium network policy.</li>
<li>PostgreSQL Flexible Server with pgvector and Azure Cache for Redis on private networking; ACR with immutable SHA tags.</li>
<li>Manual deploy workflow: GitHub OIDC login, migration job first, rollout with automatic undo.</li>
<li><strong>Nothing has been applied in Azure.</strong> It needs the owner's authorization, a subscription, region, budget, DNS/TLS and a GitHub federated credential. Rough cost of the default topology: USD 120–180 per month (unverified estimate).</li>
</ul>
</div>
</div>

<h2>Limitations</h2>
<ul>
<li>Synthetic data, two test tenants, simulated carriers. The demo sign-in of the console is not a production identity provider.</li>
<li>AI latency, tokens and cost are SIMULATED; no real model was evaluated.</li>
<li>Evaluation labels are single-author until the adjudication follow-up is completed by a second reviewer.</li>
<li>Timings come from single runs on one workstation and are not service levels.</li>
</ul>
<footer>Built from the archived OpenSpec evidence of the repository${ciRunUrl ? ' by the CI run linked above' : ''}. Evidence files: ${esc(M10)}, ${esc(M11)}.</footer>
</main></body></html>
`;

// Nothing private may be published (guard.mjs; tested by node --test infra/site/guard.test.mjs).
const leaks = findPrivateData(html);
if (leaks.length) {
  console.error(`site: refusing to publish, found ${leaks.join(', ')}`);
  process.exit(1);
}

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'index.html'), html);
writeFileSync(join(outDir, '.nojekyll'), '');
console.log(`site: wrote ${join(outDir, 'index.html')} (${Math.round(html.length / 1024)} KiB)`);
