// Load test of docs/rag-evals.md (prueba de carga): 10 concurrent sessions over a volume of
// 500 SKUs / 100 documents / 1,000 orders / 5,000 movements, 5 min warmup and 15 min measured.
// Starts the API (queue mode) and the worker from their builds against Compose PostgreSQL/Redis.
// API reads and alert latency are MEASURED on this machine; agent-run latency and tokens use the
// template synthesizer and are reported as SIMULATED. Usage:
//   node infra/scripts/load.mjs [--warmup-s=300] [--duration-s=900] [--sessions=10]
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { cpus, totalmem, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));
const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};
const WARMUP_S = arg('warmup-s', 300);
const DURATION_S = arg('duration-s', 900);
const SESSIONS = arg('sessions', 10);
const API_PORT = 3201;
const WORKER_PORT = 3202;
const api = `http://127.0.0.1:${API_PORT}`;

const dist = (p) => import(pathToFileURL(join(root, p)).href);
const evals = await dist('evals/dist/index.js');
const contracts = await dist('packages/contracts/dist/index.js');
const pg = (
  await import(pathToFileURL(join(root, 'evals', 'node_modules', 'pg', 'lib', 'index.js')).href)
).default;

const started = new Date();
const runId = `load-${started.toISOString().replace(/[-:.]/g, '').slice(0, 15)}`;
const runDir = join(root, '.smoke', runId);
await mkdir(runDir, { recursive: true });

console.log('seeding load fixture (500 SKUs, 100 documents, 1,000 orders, 5,000 movements)…');
const { skuIds, orderIds } = await evals.seedLoadFixture({
  migratorUrl: process.env.DATABASE_MIGRATOR_URL,
  runtimeUrl: process.env.DATABASE_URL,
  piiKey: process.env.PII_ENCRYPTION_KEY,
});

const owner = new pg.Client({ connectionString: process.env.DATABASE_MIGRATOR_URL });
await owner.connect();
const anaOrders = (
  await owner.query(
    "SELECT id FROM commerce.orders WHERE customer_id = '00000000-0000-4000-8000-000000000011'",
  )
).rows.map((r) => r.id);

const children = [];
function start(name, cwd, env) {
  const out = createWriteStream(join(runDir, `${name}.log`));
  const child = spawn(process.execPath, ['--import', './dist/instrumentation.js', 'dist/main.js'], {
    cwd: join(root, cwd),
    env: { ...process.env, NODE_ENV: 'production', LOG_LEVEL: 'warn', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  children.push(child);
}
start('api', 'apps/api', { API_PORT: String(API_PORT), RUN_EXECUTION: 'queue' });
start('worker', 'apps/worker', { WORKER_HEALTH_PORT: String(WORKER_PORT) });

async function waitReady(url) {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} not ready`);
}

const privateJwk = JSON.parse(
  readFileSync(
    join(root, process.env.AUTH_SIGNING_KEY_FILE ?? '.local/auth/issuer-private.jwk.json'),
    'utf8',
  ),
);
const token = (subject) =>
  contracts.signAccessToken(
    {
      subject,
      tenantId: '00000000-0000-4000-8000-000000000001',
      audience: contracts.AUDIENCES.api,
    },
    { issuer: process.env.AUTH_ISSUER, privateJwk, ttlSeconds: 3600 },
  );

const reads = [];
const runs = [];
let errors = 0;
let requests = 0;
let measuring = false;
let stop = false;

async function timed(kind, fn) {
  const t0 = performance.now();
  let ok;
  try {
    ok = await fn();
  } catch {
    ok = false;
  }
  const ms = performance.now() - t0;
  if (measuring) {
    requests += 1;
    if (!ok) errors += 1;
    if (kind === 'read') reads.push(ms);
    else runs.push(ms);
  }
}

async function session(i) {
  const bearer = { authorization: `Bearer ${token('acme-customer-ana')}` };
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  while (!stop) {
    const r = Math.random();
    if (r < 0.35) {
      await timed(
        'read',
        async () =>
          (
            await fetch(`${api}/v1/products?category=notebook&price_lt=150000&limit=20`, {
              headers: bearer,
            })
          ).ok,
      );
    } else if (r < 0.55) {
      await timed(
        'read',
        async () => (await fetch(`${api}/v1/orders/${pick(anaOrders)}`, { headers: bearer })).ok,
      );
    } else if (r < 0.7) {
      await timed(
        'read',
        async () =>
          (await fetch(`${api}/v1/orders/${pick(anaOrders)}/shipping`, { headers: bearer })).ok,
      );
    } else if (r < 0.85) {
      await timed(
        'read',
        async () => (await fetch(`${api}/v1/inventory/${pick(skuIds)}`, { headers: bearer })).ok,
      );
    } else {
      await timed('run', async () => {
        const res = await fetch(`${api}/v1/agent-runs`, {
          method: 'POST',
          headers: { ...bearer, 'content-type': 'application/json' },
          body: JSON.stringify({
            message:
              i % 2 === 0
                ? `¿Dónde está mi pedido ${pick(anaOrders)}?`
                : 'Recomiéndame una notebook de desarrollo por menos de USD 1.500',
          }),
        });
        if (res.status !== 202) return false;
        const { id } = await res.json();
        for (let k = 0; k < 240; k++) {
          const run = await (await fetch(`${api}/v1/agent-runs/${id}`, { headers: bearer })).json();
          if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status))
            return run.status === 'COMPLETED';
          await new Promise((res2) => setTimeout(res2, 200));
        }
        return false;
      });
    }
  }
}

/** Makes a load SKU critical and waits for the scheduled detector to record the alert. */
async function alertLatency(skuId) {
  const changedAt = new Date();
  await owner.query(
    'UPDATE commerce.stock_balances SET on_hand = 2, reserved = 0 WHERE sku_id = $1',
    [skuId],
  );
  for (let i = 0; i < 400; i++) {
    const row = (
      await owner.query(
        "SELECT created_at FROM commerce.anomalies WHERE sku_id = $1 AND rule_id = 'critical_stock' AND created_at >= $2 ORDER BY created_at LIMIT 1",
        [skuId, changedAt],
      )
    ).rows[0];
    if (row) return new Date(row.created_at).getTime() - changedAt.getTime();
    await new Promise((r) => setTimeout(r, 2000));
  }
  return undefined;
}

const percentile = (values, p) => {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
};
const r1 = (v) => Number(v.toFixed(1));

let exitCode = 0;
try {
  await waitReady(`${api}/readyz`);
  await waitReady(`http://127.0.0.1:${WORKER_PORT}/readyz`);
  console.log(`warmup ${String(WARMUP_S)} s with ${String(SESSIONS)} sessions…`);
  const workers = Array.from({ length: SESSIONS }, (_, i) => session(i));
  await new Promise((r) => setTimeout(r, WARMUP_S * 1000));
  measuring = true;
  const windowStart = new Date();
  console.log(`measuring ${String(DURATION_S)} s…`);
  const alertSkus = skuIds.slice(0, 3);
  const alerts = [];
  const alertJobs = alertSkus.map(
    (sku, i) =>
      new Promise((resolve) => {
        setTimeout(
          async () => {
            alerts.push(await alertLatency(sku));
            resolve();
          },
          (i * DURATION_S * 1000) / 3,
        );
      }),
  );
  await new Promise((r) => setTimeout(r, DURATION_S * 1000));
  measuring = false;
  stop = true;
  await Promise.all(workers);
  await Promise.all(alertJobs);
  const tokens = (
    await owner.query(
      "SELECT (usage->>'tokens')::int AS tokens FROM commerce.agent_runs WHERE created_at >= $1 AND status = 'COMPLETED'",
      [windowStart],
    )
  ).rows.map((r) => r.tokens);
  const measuredAlerts = alerts.filter((a) => a !== undefined);
  const environment = `${String(cpus().length)} x ${cpus()[0]?.model ?? 'cpu'}, ${String(Math.round(totalmem() / 2 ** 30))} GiB RAM, ${platform()} ${release()}, local Docker Compose PostgreSQL 17 + Redis 8`;
  const notes = `Warmup ${String(WARMUP_S)} s, measured ${String(DURATION_S)} s, ${String(SESSIONS)} sessions. ${environment}. Volume: ${String(skuIds.length)} extra SKUs, 100 extra documents, ${String(orderIds.length)} extra orders, 5000 movements.`;
  const source = 'infra/scripts/load.mjs';
  const real = evals.buildReport({
    suite: 'load',
    target: {
      id: 'api+worker',
      mode: 'real',
      description: 'API and worker builds on this machine under the documented load profile',
    },
    startedAt: started,
    results: [
      evals.observed('MEASURED', {
        metric: 'api_read_latency_p95',
        dimension: 'latency',
        unit: 'ms',
        source,
        value: r1(percentile(reads, 0.95)),
        denominator: reads.length,
        threshold: { operator: '<', value: 500 },
        notes: `p50 ${String(r1(percentile(reads, 0.5)))} ms. ${notes}`,
      }),
      evals.observed('MEASURED', {
        metric: 'error_rate',
        dimension: 'latency',
        unit: 'ratio',
        source,
        value: requests === 0 ? 0 : Number((errors / requests).toFixed(4)),
        numerator: errors,
        denominator: Math.max(1, requests),
        threshold: { operator: '<', value: 0.05 },
      }),
      evals.observed('MEASURED', {
        metric: 'anomaly_alert_latency',
        dimension: 'latency',
        unit: 'ms',
        source,
        value: measuredAlerts.length ? Math.max(...measuredAlerts) : 0,
        denominator: Math.max(1, measuredAlerts.length),
        threshold: { operator: '<', value: 330000 },
        notes: `Worst of ${String(measuredAlerts.length)}/${String(alertSkus.length)} stock changes detected by the scheduled 5-minute sweep: ${measuredAlerts.map((a) => `${String(Math.round(a / 1000))} s`).join(', ')}.`,
      }),
    ],
  });
  const simulated = evals.buildReport({
    suite: 'load-provider',
    target: {
      id: 'template-synth.v1',
      mode: 'simulated',
      description:
        'Agent runs through the queue and worker with the template synthesizer; no model latency or tokens are real',
    },
    startedAt: started,
    results: [
      evals.observed('SIMULATED', {
        metric: 'ai_workflow_latency_p95',
        dimension: 'latency',
        unit: 'ms',
        source,
        value: r1(percentile(runs, 0.95)),
        denominator: runs.length,
        threshold: { operator: '<', value: 12000 },
        notes: `p50 ${String(r1(percentile(runs, 0.5)))} ms, end to end (POST, queue, worker, polling). ${notes}`,
      }),
      evals.observed('SIMULATED', {
        metric: 'tokens_per_run_p95',
        dimension: 'token_usage',
        unit: 'tokens',
        source,
        value: percentile(tokens, 0.95),
        denominator: Math.max(1, tokens.length),
        threshold: { operator: '<=', value: 8000 },
        notes: 'Estimated tokens of the template synthesizer.',
      }),
    ],
  });
  for (const report of [real, simulated]) {
    const problems = evals.validateReport(report);
    const path = await evals.writeReport(report, join(root, 'evals', 'reports'));
    console.log(
      `${report.run.suite}: ${path}${problems.length ? ` INVALID ${problems.join('; ')}` : ''}`,
    );
    for (const r of report.results)
      console.log(
        `  ${r.status} ${r.metric} = ${String(r.value)} ${r.unit} (n=${String(r.denominator)})${r.passed === false ? ' FAILED' : ''}`,
      );
  }
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  for (const child of children) child.kill();
  await owner.end();
}
process.exit(exitCode);
