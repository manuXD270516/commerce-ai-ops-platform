// Shared helpers of the scripts that drive the production-like stack (demo.mjs, recovery-drill.mjs):
// trusted TLS to the Caddy edge, tokens from the stack's own issuer key, SSE reading, psql inside
// the private data network and a MEASURED report. Requires pnpm build on the host.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const COMPOSE = ['compose', '-f', join(root, 'infra', 'compose.prod.yaml')];
export const base =
  process.env.DEMO_BASE_URL ?? `https://localhost:${process.env.PROD_HTTPS_PORT ?? '8443'}`;
export const TENANTS = {
  acme: '00000000-0000-4000-8000-000000000001',
  globex: '00000000-0000-4000-8000-000000000002',
};
const ISSUER = process.env.AUTH_ISSUER ?? 'http://127.0.0.1:3000/local-issuer';

/**
 * Trusts Caddy's local CA explicitly (never NODE_TLS_REJECT_UNAUTHORIZED=0): copies its root
 * certificate out of the edge container and re-runs the calling script with NODE_EXTRA_CA_CERTS.
 */
export function ensureTrustedEdge() {
  if (process.env.NODE_EXTRA_CA_CERTS || !base.startsWith('https://localhost')) return;
  const caFile = join(root, '.local', 'prod', 'caddy-root.crt');
  execFileSync(
    'docker',
    [...COMPOSE, 'cp', 'edge:/data/caddy/pki/authorities/local/root.crt', caFile],
    {
      stdio: 'ignore',
    },
  );
  const child = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, NODE_EXTRA_CA_CERTS: caFile },
  });
  process.exit(child.status ?? 1);
}

export function fail(message) {
  console.error(message);
  process.exit(1);
}

const keyFile =
  process.env.DEMO_SIGNING_KEY_FILE ?? join(root, '.local', 'prod', 'issuer-private.jwk.json');
const contracts = await import(
  pathToFileURL(join(root, 'packages', 'contracts', 'dist', 'index.js')).href
).catch(() => fail('contracts not built: run pnpm build'));
const reports = await import(pathToFileURL(join(root, 'evals', 'dist', 'report.js')).href).catch(
  () => fail('evals not built: run pnpm build'),
);

export function token(subject, tenantId = TENANTS.acme) {
  if (!existsSync(keyFile)) fail(`signing key ${keyFile} missing: run pnpm prod:secrets`);
  return contracts.signAccessToken(
    { subject, tenantId, audience: contracts.AUDIENCES.api },
    { issuer: ISSUER, privateJwk: JSON.parse(readFileSync(keyFile, 'utf8')) },
  );
}

export async function call(subject, path, init = {}, tenantId = TENANTS.acme) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token(subject, tenantId)}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

/** Reads a run's SSE stream until `until(event)` holds; returns every event seen. */
export async function readEvents(subject, runId, until, { lastEventId, timeoutMs = 60_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events = [];
  try {
    const res = await fetch(`${base}/v1/agent-runs/${runId}/events`, {
      headers: {
        authorization: `Bearer ${token(subject)}`,
        ...(lastEventId === undefined ? {} : { 'last-event-id': String(lastEventId) }),
      },
      signal: controller.signal,
    });
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => l.slice(6))
          .join('\n');
        if (!data) continue;
        const event = JSON.parse(data);
        events.push(event);
        if (until(event)) return events;
      }
    }
    return events;
  } catch (error) {
    if (controller.signal.aborted) return events;
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** psql inside the private data network (the database has no published port). */
export function psql(
  sql,
  { project = COMPOSE, service = 'postgres', user = 'commerce_admin' } = {},
) {
  return execFileSync(
    'docker',
    [
      ...project,
      'exec',
      '-T',
      service,
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      user,
      '-d',
      'commerce',
      '-tAc',
      sql,
    ],
    { encoding: 'utf8' },
  ).trim();
}

export function docker(args, options = {}) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });
}

export async function waitUntil(predicate, timeoutMs, stepMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

export function createChecks() {
  const checks = [];
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: Boolean(ok), detail });
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  return { checks, check };
}

/** Writes the MEASURED report (checks ratio plus observed timings) under .smoke/<suite>-<stamp>/. */
export async function writeRunReport({ suite, description, startedAt, checks, timings, source }) {
  const passed = checks.filter((c) => c.ok).length;
  const failedNames = checks.filter((c) => !c.ok).map((c) => c.name);
  const report = reports.buildReport({
    suite,
    target: { id: 'prod-like-local', mode: 'real', description },
    startedAt,
    results: [
      reports.observed('MEASURED', {
        metric: `${suite.replace(/[^a-z0-9]+/gi, '_')}_checks_passed`,
        dimension: 'deployment',
        unit: 'ratio',
        source,
        value: checks.length ? passed / checks.length : 0,
        numerator: passed,
        denominator: checks.length,
        threshold: { operator: '==', value: 1 },
        ...(failedNames.length ? { notes: failedNames.join('; ') } : {}),
      }),
      ...Object.entries(timings).map(([name, ms]) =>
        reports.observed('MEASURED', {
          metric: name,
          dimension: 'latency',
          unit: 'ms',
          source,
          value: Math.round(ms),
          denominator: 1,
          notes: 'One observation on one workstation (Docker Desktop); illustrative, not an SLA.',
        }),
      ),
    ],
  });
  const errors = reports.validateReport(report);
  if (errors.length) throw new Error(`invalid report: ${errors.join('; ')}`);
  const dir = join(
    root,
    '.smoke',
    `${suite}-${startedAt.toISOString().replace(/[-:.]/g, '').slice(0, 15)}`,
  );
  await mkdir(dir, { recursive: true });
  return reports.writeReport(report, dir);
}
