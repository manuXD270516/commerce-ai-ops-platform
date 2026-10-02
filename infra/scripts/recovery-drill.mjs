// M11 recovery drills on the production-like stack (infra/compose.prod.yaml). Each drill acts only
// on this repo's Compose projects (commerce-ai-ops-prod and commerce-ai-ops-restore).
//   redis     Redis is stopped (all coordination state lost: no persistence). While it is down the
//             API still accepts a run and an approval, and the DB-backed ticket rate limit still
//             holds. After Redis returns, work is rebuilt from PostgreSQL: the run completes, the
//             approved action executes exactly once and no decision is lost.
//   restart   api and worker are restarted; time until healthy and a run completes afterwards.
//   rollback  a deliberately broken api image is deployed, the health gate catches it and the
//             previous immutable tag is redeployed; time to recover.
//   restore   pg_dump of the stack (worker paused for a quiet snapshot), restore into an isolated
//             PostgreSQL, verification of row counts, relations, RLS policies, audit and run state.
// Usage: pnpm prod:drill [redis|restart|rollback|restore ...]  (default: all, in that order)
// Observed times are single observations on one workstation, not an SLA.
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  base,
  call,
  COMPOSE,
  createChecks,
  docker,
  ensureTrustedEdge,
  psql,
  readEvents,
  root,
  TENANTS,
  waitUntil,
  writeRunReport,
} from './prod-lib.mjs';

ensureTrustedEdge();

const RESTORE = ['compose', '-f', join(root, 'infra', 'restore-compose.yaml')];
const BEN = '00000000-0000-4000-8000-000000000012';
const ANA_ORDER = '00000000-0000-4000-8000-000000000401';
const CARA_ORDER = '00000000-0000-4000-8000-000000000501';
const IMAGE_TAG = process.env.IMAGE_TAG ?? 'local';
const requested = process.argv.slice(2);
const drills = requested.length ? requested : ['redis', 'restart', 'rollback', 'restore'];
const startedAt = new Date();
const { checks, check } = createChecks();
const timings = {};
const compose = (args, env = {}) =>
  docker([...COMPOSE, ...args], { env: { ...process.env, IMAGE_TAG, ...env } });
const runStatus = (id) =>
  psql(`SELECT status || '/' || coalesce(outcome, '') FROM commerce.agent_runs WHERE id = '${id}'`);
/** API readiness (PostgreSQL, pgvector, Redis) read inside the stack; /readyz is not routed. */
function readiness() {
  try {
    return JSON.parse(
      compose([
        'exec',
        '-T',
        'api',
        'node',
        '-e',
        "fetch('http://127.0.0.1:3001/readyz').then(async r => console.log(JSON.stringify({ status: r.status, body: await r.json() })))",
      ]),
    );
  } catch {
    return { status: 0, body: {} };
  }
}
/** Ready = the API answers through the TLS edge and its readiness sees every dependency up. */
const healthy = async () =>
  (await fetch(`${base}/healthz`).catch(() => undefined))?.status === 200 &&
  readiness().status === 200;

async function startCancellation() {
  const orderId = randomUUID();
  psql(
    `INSERT INTO commerce.orders (tenant_id, id, customer_id, status, currency, subtotal_minor, tax_minor, shipping_minor, total_minor) VALUES ('${TENANTS.acme}', '${orderId}', '${BEN}', 'CONFIRMED', 'USD', 2900, 0, 0, 2900)`,
  );
  const run = await call('acme-customer-ben', '/v1/agent-runs', {
    method: 'POST',
    body: JSON.stringify({ message: `Quiero solicitar la cancelación del pedido ${orderId}` }),
  });
  const events = await readEvents(
    'acme-customer-ben',
    run.body.id,
    (e) => e.type === 'approval_required',
  );
  const proposal = events.find((e) => e.type === 'approval_required')?.proposal;
  const request = await call('acme-customer-ben', '/v1/action-requests', {
    method: 'POST',
    headers: { 'idempotency-key': `drill-${run.body.id}` },
    body: JSON.stringify({
      order_id: orderId,
      reason_code: proposal?.reason_code,
      expected_version: proposal?.expected_version,
      run_id: run.body.id,
    }),
  });
  return {
    orderId,
    runId: run.body.id,
    requestId: request.body.id,
    pending: request.body.status === 'PENDING',
  };
}

async function ticketAttempt(i) {
  const payload = {
    order_id: CARA_ORDER,
    category: 'delivery_delay',
    summary: 'Simulacro de recuperación: el paquete no llega todavía',
  };
  const consent = await call(
    'globex-customer-cara',
    '/v1/consents',
    { method: 'POST', body: JSON.stringify({ command: 'create_support_ticket', payload }) },
    TENANTS.globex,
  );
  return call(
    'globex-customer-cara',
    '/v1/support-tickets',
    {
      method: 'POST',
      headers: { 'idempotency-key': `drill-ticket-${startedAt.getTime()}-${i}` },
      body: JSON.stringify({ ...payload, consent_id: consent.body.id }),
    },
    TENANTS.globex,
  );
}

async function redisDrill() {
  console.log('\n== redis: coordination state lost ==');
  const pending = await startCancellation();
  check('redis: a cancellation is PENDING approval before the outage', pending.pending);
  compose(['stop', 'redis']);
  const down = performance.now();
  const ready = readiness();
  check(
    'redis: stopped (no persistence: queues and schedulers are gone); api readiness reports it',
    ready.status === 503 &&
      (ready.body.checks ?? []).some((c) => c.name === 'redis' && c.status === 'down'),
    `readyz ${ready.status}`,
  );

  const t0 = performance.now();
  const queued = await call('acme-customer-ana', '/v1/agent-runs', {
    method: 'POST',
    body: JSON.stringify({ message: `¿Dónde está mi pedido ${ANA_ORDER}?` }),
  });
  timings.drill_redis_down_run_accept_ms = performance.now() - t0;
  check(
    'redis down: the api still records a run durably and answers 202',
    queued.status === 202,
    `${queued.status} in ${Math.round(timings.drill_redis_down_run_accept_ms)} ms`,
  );
  const decision = await call('acme-approver', `/v1/approvals/${pending.requestId}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'APPROVED', reason: 'recovery drill' }),
  });
  check('redis down: the approver decision is stored', decision.status < 300, `${decision.status}`);

  const before = Number(
    psql(
      `SELECT count(*) FROM commerce.tickets WHERE created_by = 'globex-customer-cara' AND created_at > now() - interval '1 hour'`,
    ),
  );
  let limited;
  for (let i = 0; i < 6 && !limited; i++) {
    const res = await ticketAttempt(i);
    if (res.body?.code === 'BUDGET_EXCEEDED') limited = res;
  }
  const after = Number(
    psql(
      `SELECT count(*) FROM commerce.tickets WHERE created_by = 'globex-customer-cara' AND created_at > now() - interval '1 hour'`,
    ),
  );
  check(
    'redis down: writes do not bypass the rate limit (enforced in PostgreSQL)',
    limited !== undefined && after <= 5,
    `tickets in the last hour ${before} -> ${after}, limit 5`,
  );
  check(
    'redis down: nothing executed yet',
    psql(
      `SELECT count(*) FROM commerce.action_executions WHERE action_request_id = '${pending.requestId}'`,
    ) === '0',
  );

  compose(['start', 'redis']);
  const up = performance.now();
  timings.drill_redis_outage_ms = up - down;
  const recovered = await waitUntil(
    async () =>
      runStatus(queued.body.id) === 'COMPLETED/ANSWERED' &&
      runStatus(pending.runId) === 'COMPLETED/ACTION_EXECUTED',
    120_000,
  );
  timings.drill_redis_recovery_ms = performance.now() - up;
  check(
    'redis back: queued and approved work is rebuilt from PostgreSQL',
    recovered,
    `${runStatus(queued.body.id)}, ${runStatus(pending.runId)} after ${Math.round(timings.drill_redis_recovery_ms)} ms`,
  );
  check(
    'redis back: one approval, exactly one execution, order changed once',
    psql(
      `SELECT count(*) FROM commerce.approvals WHERE action_request_id = '${pending.requestId}'`,
    ) === '1' &&
      psql(
        `SELECT count(*) FROM commerce.action_executions WHERE action_request_id = '${pending.requestId}'`,
      ) === '1' &&
      psql(
        `SELECT status || ':' || version FROM commerce.orders WHERE id = '${pending.orderId}'`,
      ) === 'CANCELLATION_REQUESTED:2',
  );
  const completedEvents = psql(
    `SELECT string_agg(n::text, ',' ORDER BY run_id) FROM (SELECT run_id, count(*) AS n FROM commerce.run_events WHERE run_id IN ('${queued.body.id}', '${pending.runId}') AND data->>'type' = 'completed' GROUP BY run_id) s`,
  );
  check(
    'redis back: each run has a single completed event',
    completedEvents === '1,1',
    `completed events per run: ${completedEvents}`,
  );
  const logs = compose(['logs', 'worker', '--since', '5m']);
  check('redis back: the worker re-registered its schedulers', logs.includes('redis reconnected'));
}

async function restartDrill() {
  console.log('\n== restart: api and worker ==');
  const t0 = performance.now();
  compose(['restart', 'api', 'worker']);
  const back = await waitUntil(healthy, 120_000);
  timings.drill_restart_to_ready_ms = performance.now() - t0;
  check(
    'restart: api ready again through the edge',
    back,
    `${Math.round(timings.drill_restart_to_ready_ms)} ms`,
  );
  const run = await call('acme-customer-ana', '/v1/agent-runs', {
    method: 'POST',
    body: JSON.stringify({ message: `¿Dónde está mi pedido ${ANA_ORDER}?` }),
  });
  const events = await readEvents('acme-customer-ana', run.body.id, (e) => e.type === 'completed');
  check('restart: a new run completes after the restart', events.at(-1)?.outcome === 'ANSWERED');
}

async function rollbackDrill() {
  console.log('\n== rollback: broken api release ==');
  const broken = 'drill-broken';
  docker(['build', '-q', '-t', `commerce-ai-ops/api:${broken}`, '-'], {
    input: `FROM commerce-ai-ops/api:${IMAGE_TAG}\nCMD ["node", "-e", "console.error('drill: broken release'); process.exit(1)"]\n`,
  });
  const t0 = performance.now();
  let gate = 'passed';
  try {
    compose(['up', '-d', '--no-deps', '--no-build', '--wait', '--wait-timeout', '45', 'api'], {
      IMAGE_TAG: broken,
    });
  } catch {
    gate = 'failed';
  }
  timings.drill_rollback_detect_ms = performance.now() - t0;
  check(
    'rollback: the health gate rejects the broken release',
    gate === 'failed' && !(await healthy()),
  );
  const t1 = performance.now();
  compose(['up', '-d', '--no-deps', '--no-build', '--wait', '--wait-timeout', '120', 'api']);
  const back = await waitUntil(healthy, 60_000);
  timings.drill_rollback_restore_ms = performance.now() - t1;
  const image = docker([
    'inspect',
    '--format',
    '{{.Config.Image}}',
    compose(['ps', '-q', 'api']).trim(),
  ]).trim();
  check(
    'rollback: the previous immutable tag serves again',
    back && image === `commerce-ai-ops/api:${IMAGE_TAG}`,
    `${image} in ${Math.round(timings.drill_rollback_restore_ms)} ms`,
  );
  const order = await call('acme-customer-ana', `/v1/orders/${ANA_ORDER}`);
  check(
    'rollback: data intact after rollback',
    order.status === 200 && order.body.id === ANA_ORDER,
  );
  docker(['image', 'rm', `commerce-ai-ops/api:${broken}`]);
}

const VERIFY_SQL = `
SELECT json_build_object(
  'counts', (SELECT json_object_agg(t, n ORDER BY t) FROM (
    SELECT 'orders' t, count(*) n FROM commerce.orders UNION ALL
    SELECT 'order_items', count(*) FROM commerce.order_items UNION ALL
    SELECT 'shipments', count(*) FROM commerce.shipments UNION ALL
    SELECT 'customers', count(*) FROM commerce.customers UNION ALL
    SELECT 'tickets', count(*) FROM commerce.tickets UNION ALL
    SELECT 'action_requests', count(*) FROM commerce.action_requests UNION ALL
    SELECT 'approvals', count(*) FROM commerce.approvals UNION ALL
    SELECT 'action_executions', count(*) FROM commerce.action_executions UNION ALL
    SELECT 'audit_events', count(*) FROM commerce.audit_events UNION ALL
    SELECT 'outbox', count(*) FROM commerce.outbox UNION ALL
    SELECT 'agent_runs', count(*) FROM commerce.agent_runs UNION ALL
    SELECT 'run_events', count(*) FROM commerce.run_events UNION ALL
    SELECT 'graph_checkpoints', count(*) FROM commerce.graph_checkpoints UNION ALL
    SELECT 'chunks', count(*) FROM commerce.chunks) s),
  'runs_by_status', (SELECT json_object_agg(status, n ORDER BY status) FROM (SELECT status, count(*) n FROM commerce.agent_runs GROUP BY status) s),
  'last_audit', (SELECT id::text || '@' || recorded_at::text FROM commerce.audit_events ORDER BY recorded_at DESC, id DESC LIMIT 1),
  'rls_tables', (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'commerce' AND c.relkind = 'r' AND c.relrowsecurity),
  'policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'commerce'),
  'foreign_keys', (SELECT count(*) FROM pg_constraint WHERE contype = 'f' AND connamespace = 'commerce'::regnamespace AND convalidated),
  'orphan_items', (SELECT count(*) FROM commerce.order_items i LEFT JOIN commerce.orders o ON o.tenant_id = i.tenant_id AND o.id = i.order_id WHERE o.id IS NULL),
  'orphan_approvals', (SELECT count(*) FROM commerce.approvals a LEFT JOIN commerce.action_requests r ON r.tenant_id = a.tenant_id AND r.id = a.action_request_id WHERE r.id IS NULL),
  'migrations', (SELECT count(*) FROM commerce.schema_migrations)
)::text`;

async function restoreDrill() {
  console.log('\n== restore: isolated rehearsal ==');
  // Quiet snapshot: pause the only background writer, so live and restored counts are comparable.
  compose(['stop', 'worker']);
  try {
    const live = JSON.parse(psql(VERIFY_SQL));
    const t0 = performance.now();
    const dump = docker(
      [...COMPOSE, 'exec', '-T', 'postgres', 'pg_dump', '-U', 'commerce_admin', '-Fc', 'commerce'],
      {
        encoding: 'buffer',
        maxBuffer: 1024 * 1024 * 1024,
      },
    );
    timings.drill_backup_dump_ms = performance.now() - t0;
    const dir = join(root, '.local', 'prod', 'backups');
    mkdirSync(dir, { recursive: true });
    const file = join(
      dir,
      `commerce-${startedAt.toISOString().replace(/[-:.]/g, '').slice(0, 15)}.dump`,
    );
    writeFileSync(file, dump);
    check(
      'restore: pg_dump of the stack written',
      dump.length > 0,
      `${Math.round(dump.length / 1024)} KiB -> ${file}`,
    );

    const t1 = performance.now();
    docker([...RESTORE, 'up', '-d', '--wait']);
    timings.drill_restore_instance_ready_ms = performance.now() - t1;
    const roles = psql(
      "SELECT string_agg(rolname, ' ') FROM pg_roles WHERE rolname LIKE 'commerce\\_%' AND rolname <> 'commerce_admin'",
    )
      .split(' ')
      .filter(Boolean);
    const target = { project: RESTORE, service: 'postgres-restore' };
    for (const role of roles) psql(`CREATE ROLE ${role} NOLOGIN`, target);
    const t2 = performance.now();
    docker(
      [
        ...RESTORE,
        'exec',
        '-T',
        'postgres-restore',
        'pg_restore',
        '-U',
        'commerce_admin',
        '-d',
        'commerce',
        '--exit-on-error',
      ],
      {
        input: dump,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    timings.drill_restore_pg_restore_ms = performance.now() - t2;
    const restored = JSON.parse(psql(VERIFY_SQL, target));
    timings.drill_restore_total_ms = performance.now() - t1;
    writeFileSync(`${file}.verify.json`, JSON.stringify({ live, restored }, null, 2));
    check(
      'restore: row counts match table by table',
      JSON.stringify(live.counts) === JSON.stringify(restored.counts),
      JSON.stringify(restored.counts),
    );
    check(
      'restore: run state matches',
      JSON.stringify(live.runs_by_status) === JSON.stringify(restored.runs_by_status),
      JSON.stringify(restored.runs_by_status),
    );
    check('restore: audit trail ends at the same event', live.last_audit === restored.last_audit);
    check(
      'restore: relations valid (all foreign keys validated, no orphans) and RLS policies present',
      restored.foreign_keys === live.foreign_keys &&
        restored.orphan_items === 0 &&
        restored.orphan_approvals === 0 &&
        restored.policies === live.policies &&
        restored.rls_tables === live.rls_tables &&
        restored.migrations === live.migrations,
      `${restored.foreign_keys} FKs, ${restored.policies} policies on ${restored.rls_tables} RLS tables, ${restored.migrations} migrations`,
    );
  } finally {
    docker([...RESTORE, 'down', '-v']);
    compose(['start', 'worker']);
  }
}

// Every drill restarts containers; none may reset data (e.g. a migration job re-running a seed).
const runsAtStart = Number(psql('SELECT count(*) FROM commerce.agent_runs'));

const table = {
  redis: redisDrill,
  restart: restartDrill,
  rollback: rollbackDrill,
  restore: restoreDrill,
};
for (const name of drills) {
  if (!table[name]) {
    check(`unknown drill ${name}`, false);
    continue;
  }
  try {
    await table[name]();
  } catch (error) {
    check(
      `${name} drill completed`,
      false,
      error instanceof Error ? error.message.split('\n')[0] : String(error),
    );
  }
}
await new Promise((r) => setTimeout(r, 3000));
const runsAtEnd = Number(psql('SELECT count(*) FROM commerce.agent_runs'));
check(
  'state survives every drill: no reseed or data loss',
  runsAtEnd > runsAtStart ||
    (drills.length === 1 && drills[0] === 'restore' && runsAtEnd === runsAtStart),
  `agent_runs ${runsAtStart} -> ${runsAtEnd}`,
);

const path = await writeRunReport({
  suite: 'm11-recovery-drill',
  description: `compose.prod.yaml (${drills.join(', ')}) on one workstation; IMAGE_TAG=${IMAGE_TAG}`,
  startedAt,
  checks,
  timings,
  source: 'infra/scripts/recovery-drill.mjs',
});
console.log(`\nReport: ${path}`);
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
