// M0 smoke: starts web, api, worker and commerce-mcp-server from their builds, sends requests
// web -> api with known correlation ids and asserts they appear in both services' structured
// logs. Requires `pnpm build` and `pnpm infra:up` (or infra:up:tracing with --tracing).
// Writes a MEASURED report to .smoke/<run>/ and exits 1 on any failed check.
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const tracing = process.argv.includes('--tracing');
const REQUESTS = 20;

if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));
for (const key of ['DATABASE_URL', 'REDIS_URL']) {
  if (!process.env[key]) fail(`${key} missing: copy .env.example to .env or export it`);
}
if (tracing) {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||= 'http://127.0.0.1:4318';
}
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) process.env.OTEL_BSP_SCHEDULE_DELAY = '200';

const { buildReport, observed, validateReport, writeReport } = await import(
  pathToFileURL(join(root, 'evals', 'dist', 'report.js')).href
).catch(() => fail('evals not built: run pnpm build'));

const startedAt = new Date();
const runId = `smoke-${startedAt.toISOString().replace(/[-:.]/g, '').slice(0, 15)}`;
const runDir = join(root, '.smoke', runId);
await mkdir(runDir, { recursive: true });

const services = [
  {
    name: 'api',
    cwd: 'apps/api',
    args: ['--import', './dist/instrumentation.js', 'dist/main.js'],
    ready: `http://127.0.0.1:${process.env.API_PORT ?? 3001}/readyz`,
  },
  {
    name: 'worker',
    cwd: 'apps/worker',
    args: ['--import', './dist/instrumentation.js', 'dist/main.js'],
    ready: `http://127.0.0.1:${process.env.WORKER_HEALTH_PORT ?? 3002}/readyz`,
  },
  {
    name: 'commerce-mcp-server',
    cwd: 'apps/commerce-mcp-server',
    args: ['--import', './dist/instrumentation.js', 'dist/main.js'],
    ready: `http://127.0.0.1:${process.env.MCP_PORT ?? 3003}/readyz`,
  },
  {
    name: 'web',
    cwd: 'apps/web',
    args: ['node_modules/next/dist/bin/next', 'start', '--port', '3000', '--hostname', '127.0.0.1'],
    ready: 'http://127.0.0.1:3000/',
  },
];

for (const svc of services) {
  const built = svc.name === 'web' ? '.next/BUILD_ID' : 'dist/main.js';
  if (!existsSync(join(root, svc.cwd, built))) fail(`${svc.name} not built: run pnpm build`);
  if (await reachable(svc.ready))
    fail(`${svc.ready} already answers: stop the running ${svc.name} first`);
}

const logs = new Map();
const children = [];
for (const svc of services) {
  const lines = [];
  logs.set(svc.name, lines);
  const out = createWriteStream(join(runDir, `${svc.name}.log`));
  const child = spawn(process.execPath, svc.args, {
    cwd: join(root, svc.cwd),
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buffer = '';
  const onData = (chunk) => {
    out.write(chunk);
    buffer += chunk.toString();
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const line of parts) {
      try {
        lines.push(JSON.parse(line));
      } catch {
        // Non-JSON framework banners (e.g. Next.js) are kept only in the raw log file.
      }
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  children.push(child);
}

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  const readiness = await Promise.all(services.map((svc) => waitFor(svc.ready, 90_000)));
  services.forEach((svc, i) => check(`${svc.name} ready`, readiness[i]));
  if (!readiness.every(Boolean)) throw new Error('services not ready');

  const apiReady = await (await fetch(services[0].ready)).json();
  check(
    'api readiness sees postgres, pgvector and redis',
    apiReady.checks.every((c) => c.status === 'up') && apiReady.checks.length === 3,
    apiReady.checks.map((c) => `${c.name}=${c.status}`).join(' '),
  );

  const durations = [];
  const ids = [];
  let bodiesOk = 0;
  for (let i = 0; i < REQUESTS; i++) {
    const id = `${runId}-req-${String(i).padStart(2, '0')}`;
    ids.push(id);
    const started = performance.now();
    const res = await fetch('http://127.0.0.1:3000/api/status', {
      headers: { 'x-correlation-id': id },
    });
    const body = await res.json();
    durations.push(performance.now() - started);
    if (
      res.status === 200 &&
      res.headers.get('x-correlation-id') === id &&
      body.correlation_id === id &&
      body.api?.correlation_id === id
    )
      bodiesOk++;
  }
  check(
    'web -> api responses echo the correlation id',
    bodiesOk === REQUESTS,
    `${bodiesOk}/${REQUESTS}`,
  );

  const bad = await fetch('http://127.0.0.1:3000/api/status', {
    headers: { 'x-correlation-id': 'bad id; drop' },
  });
  const badBody = await bad.json();
  check(
    'malformed correlation id is replaced end to end',
    bad.status === 200 &&
      badBody.correlation_id !== 'bad id; drop' &&
      badBody.api?.correlation_id === badBody.correlation_id,
  );

  const mcp = await fetch(`http://127.0.0.1:${process.env.MCP_PORT ?? 3003}/mcp`, {
    method: 'POST',
    body: '{}',
  });
  check('commerce-mcp-server requires authentication on /mcp', mcp.status === 401);

  const unauthenticated = await fetch(
    `http://127.0.0.1:${process.env.API_PORT ?? 3001}/v1/products`,
  );
  check('api rejects catalog calls without a bearer token', unauthenticated.status === 401);

  const catalogHtml = await (await fetch('http://127.0.0.1:3000/catalog')).text();
  check(
    'web catalog reaches the api with a signed token and applies price_minor < 150000',
    catalogHtml.includes('NB-DEV-16') &&
      catalogHtml.includes('NB-DEV-32') &&
      !catalogHtml.includes('NB-DEV-32X') &&
      !catalogHtml.includes('NB-WS-64'),
  );

  const jobId = `${runId}-job`;
  const requireFromWorker = createRequire(join(root, 'apps', 'worker', 'package.json'));
  const { Queue } = await import(pathToFileURL(requireFromWorker.resolve('bullmq')).href);
  const { Redis } = await import(pathToFileURL(requireFromWorker.resolve('ioredis')).href);
  const connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  const queue = new Queue('system-diagnostics', { connection });
  await queue.add(
    'diagnostic',
    { correlation_id: jobId },
    { removeOnComplete: true, removeOnFail: true },
  );
  await queue.close();
  await connection.quit();

  await sleep(tracing ? 2500 : 1000);

  const web = logs.get('web');
  const api = logs.get('api');
  const worker = logs.get('worker');
  let correlated = 0;
  let sharedTrace = 0;
  for (const id of ids) {
    const w = web.find((l) => l.correlation_id === id && l.msg === 'upstream call completed');
    const a = api.find((l) => l.correlation_id === id && l.msg === 'request completed');
    if (w && a) correlated++;
    if (w?.trace_id && w.trace_id === a?.trace_id) sharedTrace++;
  }
  check(
    'correlation id present in web and api structured logs',
    correlated === REQUESTS,
    `${correlated}/${REQUESTS}`,
  );
  check(
    'web and api log the same trace_id (W3C propagation)',
    sharedTrace === REQUESTS,
    `${sharedTrace}/${REQUESTS}`,
  );
  const allLogs = [...logs.values()].flat();
  check(
    'malformed correlation id never reaches logs',
    !JSON.stringify(allLogs).includes('bad id; drop'),
  );
  const jobLogged = await waitUntil(
    () => worker.some((l) => l.correlation_id === jobId && l.msg === 'diagnostic job processed'),
    10_000,
  );
  check('worker logs the job correlation id after a Redis hop', jobLogged);

  let traceOk;
  if (tracing) {
    const traceId = web.find((l) => l.correlation_id === ids[0])?.trace_id;
    const found = traceId
      ? await waitUntil(async () => {
          const res = await fetch(`http://127.0.0.1:16686/api/traces/${traceId}`).catch(
            () => undefined,
          );
          if (!res?.ok) return false;
          const data = await res.json();
          const names = new Set(
            Object.values(data.data?.[0]?.processes ?? {}).map((p) => p.serviceName),
          );
          return names.has('web') && names.has('api');
        }, 15_000)
      : false;
    traceOk = found;
    check('Jaeger holds one trace spanning web and api', found, traceId ?? 'no trace id');
  }

  const sorted = [...durations].sort((x, y) => x - y);
  const pct = (p) =>
    Math.round(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]);
  const source = 'infra/scripts/smoke.mjs';
  const latencyNote =
    'Host-local diagnostic hop web -> api (/v1/status), sequential, first requests include warm-up. Infrastructure only: not the api_read_latency_p95 demo gate.';
  const passedChecks = checks.filter((c) => c.ok).length;
  const report = buildReport({
    suite: 'm0-smoke',
    target: {
      id: 'local-stack',
      mode: 'real',
      description: `web, api, worker and commerce-mcp-server builds against Compose PostgreSQL/Redis${tracing ? ' and Jaeger' : ''}`,
    },
    startedAt,
    results: [
      observed('MEASURED', {
        metric: 'smoke_checks_passed',
        dimension: 'bootstrap',
        unit: 'ratio',
        source,
        value: passedChecks / checks.length,
        numerator: passedChecks,
        denominator: checks.length,
        threshold: { operator: '==', value: 1 },
        notes:
          checks
            .filter((c) => !c.ok)
            .map((c) => c.name)
            .join('; ') || undefined,
      }),
      observed('MEASURED', {
        metric: 'smoke_correlation_propagation',
        dimension: 'observability',
        unit: 'ratio',
        source,
        value: correlated / REQUESTS,
        numerator: correlated,
        denominator: REQUESTS,
        threshold: { operator: '==', value: 1 },
      }),
      observed('MEASURED', {
        metric: 'smoke_trace_context_propagation',
        dimension: 'observability',
        unit: 'ratio',
        source,
        value: sharedTrace / REQUESTS,
        numerator: sharedTrace,
        denominator: REQUESTS,
        threshold: { operator: '==', value: 1 },
      }),
      ...(tracing
        ? [
            observed('MEASURED', {
              metric: 'smoke_trace_exported',
              dimension: 'observability',
              unit: 'ratio',
              source,
              value: traceOk ? 1 : 0,
              numerator: traceOk ? 1 : 0,
              denominator: 1,
              threshold: { operator: '==', value: 1 },
            }),
          ]
        : []),
      observed('MEASURED', {
        metric: 'smoke_web_api_roundtrip_p50',
        dimension: 'latency',
        unit: 'ms',
        source,
        value: pct(50),
        denominator: REQUESTS,
        notes: latencyNote,
      }),
      observed('MEASURED', {
        metric: 'smoke_web_api_roundtrip_p95',
        dimension: 'latency',
        unit: 'ms',
        source,
        value: pct(95),
        denominator: REQUESTS,
        notes: latencyNote,
      }),
    ].map(stripUndefined),
  });
  const errors = validateReport(report);
  if (errors.length) check('smoke report is valid', false, errors.join('; '));
  const path = await writeReport(report, runDir);
  console.log(`\nReport: ${path}\nLogs:   ${runDir}`);
} catch (error) {
  check('smoke completed', false, error instanceof Error ? error.message : String(error));
} finally {
  for (const child of children) stop(child);
}

process.exitCode = checks.every((c) => c.ok) ? 0 : 1;

function stop(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      child.kill();
    }
  } else {
    child.kill('SIGTERM');
  }
}

function stripUndefined(result) {
  return Object.fromEntries(Object.entries(result).filter(([, v]) => v !== undefined));
}

async function reachable(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

async function waitFor(url, timeoutMs) {
  return waitUntil(async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(1000) }).catch(() => undefined);
    return res?.status === 200;
  }, timeoutMs);
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(300);
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  console.error(`smoke: ${message}`);
  process.exit(1);
}
