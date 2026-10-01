// Release gates (M10): runs the sealed holdouts, reads the latest load-test reports and evaluates
// every gate of gates/gates.v0.json. Exits 1 if any gate fails or has no observation; a security
// gate failure blocks the release regardless of averages. Usage: pnpm evals:release
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOpsSuite } from './ops-suite.js';
import {
  meetsThreshold,
  validateReport,
  writeReport,
  type EvalReport,
  type EvalResult,
  type GateDefinition,
} from './report.js';
import { runRetrievalSuites } from './retrieval-suite.js';
import { runRouterSuites } from './router-suite.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(root, '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const outDir = process.env.EVALS_REPORT_DIR ?? join(root, 'reports');
const fixtures = join(root, 'fixtures');

const { DATABASE_ADMIN_URL, DATABASE_MIGRATOR_URL, DATABASE_URL, PII_ENCRYPTION_KEY } = process.env;
if (!DATABASE_ADMIN_URL || !DATABASE_MIGRATOR_URL || !DATABASE_URL || !PII_ENCRYPTION_KEY) {
  throw new Error('evals:release needs the DATABASE_* URLs and PII_ENCRYPTION_KEY');
}
const urls = {
  adminUrl: DATABASE_ADMIN_URL,
  migratorUrl: DATABASE_MIGRATOR_URL,
  runtimeUrl: DATABASE_URL,
  piiKey: PII_ENCRYPTION_KEY,
};

/** Gates whose failure blocks the release on its own (docs/rag-evals.md). */
const SECURITY = new Set([
  'unauthorized_effects',
  'unauthorized_reads',
  'forbidden_tool_calls',
  'critical_fact_inventions',
  'recommendation_eligible_ratio',
]);

async function latest(prefix: string): Promise<EvalReport | undefined> {
  const files = (await readdir(outDir).catch(() => [] as string[]))
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json') && /\d{8}T\d{6}/.test(f))
    .sort();
  const file = files.at(-1);
  if (!file) return undefined;
  return JSON.parse(await readFile(join(outDir, file), 'utf8')) as EvalReport;
}

const reports: EvalReport[] = [];
const ops = await runOpsSuite(fixtures, urls, 'holdout', 3);
reports.push(...ops.reports);
reports.push(...(await runRouterSuites(fixtures)).filter((r) => r.run.suite === 'router-holdout'));
reports.push(
  ...(
    await runRetrievalSuites(fixtures, { adminUrl: urls.adminUrl, runtimeUrl: urls.runtimeUrl })
  ).filter((r) => r.run.suite === 'retrieval-holdout'),
);
for (const report of reports) {
  const problems = validateReport(report);
  if (problems.length)
    throw new Error(`invalid report ${report.run.suite}: ${problems.join('; ')}`);
  await writeReport(report, outDir);
}
const load = await latest('load-2');
const loadProvider = await latest('load-provider-2');

const ALIASES: Record<string, string> = {
  retrieval_recall_at_5: 'retrieval_recall_at_5_hybrid',
  retrieval_mrr_at_5: 'retrieval_mrr_at_5_hybrid',
};
/** Load-test values take precedence for latency gates: they are measured under the load profile. */
const sources: (EvalReport | undefined)[] = [load, loadProvider, ...reports];

function find(metric: string): { result: EvalResult; report: EvalReport } | undefined {
  const name = ALIASES[metric] ?? metric;
  for (const report of sources) {
    const result = report?.results.find((r) => r.metric === name && r.status !== 'EXPECTED');
    if (report && result) return { result, report };
  }
  return undefined;
}

const gates = (
  JSON.parse(await readFile(join(root, 'gates', 'gates.v0.json'), 'utf8')) as {
    gates: GateDefinition[];
  }
).gates;
const rows = gates.map((gate) => {
  const hit = find(gate.metric);
  const passed =
    hit?.result.value !== undefined && meetsThreshold(hit.result.value, gate.threshold);
  return {
    metric: gate.metric,
    dimension: gate.dimension,
    threshold: `${gate.threshold.operator} ${String(gate.threshold.value)}`,
    value: hit?.result.value ?? null,
    unit: gate.unit,
    status: hit?.result.status ?? 'NOT OBSERVED',
    n: hit?.result.denominator ?? null,
    source: hit ? `${hit.report.run.suite} (${hit.report.run.id})` : '—',
    passed,
    security: SECURITY.has(gate.metric),
  };
});
const failed = rows.filter((r) => !r.passed);
const securityFailed = failed.filter((r) => r.security);
const simulatedGates = rows.filter((r) => r.status === 'SIMULATED').map((r) => r.metric);
const verdict = failed.length === 0 ? 'PASS' : 'FAIL';
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
const summary = {
  verdict,
  generated_at: new Date().toISOString(),
  datasets: reports.map((r) => r.run.dataset).filter(Boolean),
  gates: rows,
  failed: failed.map((r) => r.metric),
  security_failed: securityFailed.map((r) => r.metric),
  simulated_gates: simulatedGates,
  notes: [
    'Holdouts (ops-eval@1.0.0 holdout, router@0.1.0 holdout, knowledge@0.1.0 holdout) were not used for tuning after the configuration was fixed.',
    'SIMULATED gates describe orchestration with the template synthesizer, never a real provider; a PASS there does not certify real model latency, tokens or cost.',
    'Labels are single-author and not adjudicated by a second reviewer; factuality is checked deterministically against the database without a human review sample.',
  ],
};
const md = [
  `# Release gates — ${verdict}`,
  '',
  `Generated ${summary.generated_at}. Failed: ${summary.failed.join(', ') || 'none'}. Security failures: ${summary.security_failed.join(', ') || 'none'}.`,
  '',
  '| Gate | Dimension | Threshold | Value | n | Status | Source | Passed |',
  '|---|---|---|---|---|---|---|---|',
  ...rows.map(
    (r) =>
      `| ${r.metric}${r.security ? ' (security)' : ''} | ${r.dimension} | ${r.threshold} | ${r.value === null ? '—' : `${String(r.value)} ${r.unit}`} | ${r.n === null ? '—' : String(r.n)} | ${r.status} | ${r.source} | ${r.passed ? 'yes' : 'NO'} |`,
  ),
  '',
  ...summary.notes.map((n) => `- ${n}`),
  '',
].join('\n');
await writeFile(
  join(outDir, `release-gates-${stamp}.json`),
  `${JSON.stringify(summary, null, 2)}\n`,
);
await writeFile(join(outDir, `release-gates-${stamp}.md`), md);
console.log(md);
process.exitCode = verdict === 'PASS' ? 0 : 1;
