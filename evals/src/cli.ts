import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset } from './fixtures.js';
import {
  buildReport,
  expectedFromGates,
  validateReport,
  writeReport,
  type EvalReport,
  type GateDefinition,
} from './report.js';
import { runRetrievalSuites } from './retrieval-suite.js';
import { runExactMatchSuite } from './suites.js';
import { correlationContractTarget, simulatedProviderTarget } from './targets.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(root, '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const outDir = process.env.EVALS_REPORT_DIR ?? join(root, 'reports');

const gatesFile = JSON.parse(await readFile(join(root, 'gates', 'gates.v0.json'), 'utf8')) as {
  source: string;
  gates: GateDefinition[];
};
const dataset = await loadDataset(join(root, 'fixtures', 'harness-selftest', '0.1.0'));

const reports: EvalReport[] = [
  buildReport({
    suite: 'demo-gates',
    target: {
      id: 'gates.v0',
      mode: 'none',
      description: 'Proposed demo gates from docs/rag-evals.md; nothing measured yet',
    },
    startedAt: new Date(),
    results: expectedFromGates(gatesFile.gates, gatesFile.source),
  }),
  runExactMatchSuite(dataset, correlationContractTarget, {
    suite: 'correlation-contract',
    metric: 'correlation_contract_conformance',
    dimension: 'harness',
    source: 'packages/contracts/src/correlation.ts',
    threshold: { operator: '==', value: 1 },
  }),
  runExactMatchSuite(dataset, simulatedProviderTarget, {
    suite: 'simulated-selftest',
    metric: 'selftest_exact_match',
    dimension: 'harness',
    source: 'evals/src/targets.ts',
    notes:
      'Plumbing check with one deliberate mismatch (sim-004); says nothing about any provider.',
  }),
];

// Suites against real code and the local database; skipped (and said so) without a database.
const { DATABASE_ADMIN_URL: adminUrl, DATABASE_URL: runtimeUrl } = process.env;
if (adminUrl && runtimeUrl) {
  reports.push(...(await runRetrievalSuites(join(root, 'fixtures'), { adminUrl, runtimeUrl })));
} else {
  console.log('retrieval suites skipped: DATABASE_ADMIN_URL and DATABASE_URL are not set');
}

let exitCode = 0;
for (const report of reports) {
  const errors = validateReport(report);
  const path = await writeReport(report, outDir);
  const { expected, simulated, measured, failed } = report.summary;
  console.log(
    `${report.run.suite.padEnd(22)} target=${report.run.target.mode.padEnd(9)} EXPECTED=${expected} SIMULATED=${simulated} MEASURED=${measured} failed=${failed} -> ${relative(process.cwd(), path)}`,
  );
  if (errors.length > 0) {
    console.error(`  invalid report: ${errors.join('; ')}`);
    exitCode = 1;
  }
  if (failed > 0 && report.results.some((r) => r.status === 'MEASURED' && r.passed === false)) {
    exitCode = 1;
  }
}
process.exitCode = exitCode;
