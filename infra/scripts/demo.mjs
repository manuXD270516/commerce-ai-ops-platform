// M11 demo against the production-like stack (infra/compose.prod.yaml), only through the TLS edge:
// three cases (order status, recommendation, inventory explanation), a cancellation that needs a
// second person's approval, an idempotent replay of the confirmation and a replay of the run's
// event stream. Synthetic data; answers come from the deterministic template provider (no LLM).
// Usage: pnpm prod:demo  (stack up via pnpm prod:up; pnpm build on the host for token signing).
// Writes a MEASURED report under .smoke/m11-demo-<stamp>/ and exits 1 on any failed check.
import { randomUUID } from 'node:crypto';
import {
  base,
  call,
  createChecks,
  ensureTrustedEdge,
  psql,
  readEvents,
  writeRunReport,
} from './prod-lib.mjs';

ensureTrustedEdge();

const ANA_ORDER = '00000000-0000-4000-8000-000000000401';
const BEN = '00000000-0000-4000-8000-000000000012';
// A fresh synthetic CONFIRMED order per run keeps the demo repeatable (the seeded one changes state).
const BEN_ORDER = randomUUID();
const startedAt = new Date();
const { checks, check } = createChecks();
const timings = {};

async function runCase(metric, name, subject, message, expect) {
  const started = performance.now();
  const created = await call(subject, '/v1/agent-runs', {
    method: 'POST',
    body: JSON.stringify({ message }),
  });
  if (created.status !== 202) {
    check(name, false, `POST /v1/agent-runs -> ${created.status}`);
    return;
  }
  const events = await readEvents(subject, created.body.id, (e) => e.type === 'completed');
  timings[metric] = performance.now() - started;
  const done = events.find((e) => e.type === 'completed');
  check(
    name,
    done && expect(done),
    done
      ? `${done.status}/${done.outcome} in ${Math.round(timings[metric])} ms`
      : 'no completed event',
  );
}

const stock = () =>
  psql(
    "SELECT string_agg(sku_id::text || ':' || on_hand || ':' || reserved, ',' ORDER BY sku_id, warehouse_id) FROM commerce.stock_balances",
  );

try {
  // Edge: TLS with security headers; MCP, the worker and the data services are not routed.
  const health = await fetch(`${base}/healthz`);
  check('edge serves the api over TLS with a trusted local CA', health.status === 200, base);
  check(
    'edge sets HSTS and nosniff',
    (health.headers.get('strict-transport-security') ?? '').includes('max-age') &&
      health.headers.get('x-content-type-options') === 'nosniff',
  );
  const mcp = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  });
  const mcpText = await mcp.text();
  check(
    'mcp is not reachable through the edge',
    !mcpText.includes('"jsonrpc"'),
    `POST /mcp -> ${mcp.status} from the console, not the MCP server`,
  );
  const noAuth = await fetch(`${base}/v1/products`);
  check('api rejects calls without a bearer token', noAuth.status === 401);

  // Console sign-in behind the proxy: the session cookie must be Secure.
  const signIn = await fetch(`${base}/api/session`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'subject=acme-customer-ana',
  });
  const cookie = signIn.headers.get('set-cookie') ?? '';
  check(
    'console sign-in over TLS sets a Secure, HttpOnly, SameSite=Strict cookie',
    signIn.status === 303 &&
      /;\s*Secure/i.test(cookie) &&
      /HttpOnly/i.test(cookie) &&
      /SameSite=Strict/i.test(cookie),
  );

  await runCase(
    'demo_case1_order_status_ms',
    'case 1: order status answered with recorded evidence',
    'acme-customer-ana',
    `¿Dónde está mi pedido ${ANA_ORDER}?`,
    (c) =>
      c.status === 'COMPLETED' &&
      c.outcome === 'ANSWERED' &&
      (c.findings ?? []).some((f) => f.specialist === 'order' && f.facts.length > 0),
  );
  await runCase(
    'demo_case2_recommendation_ms',
    'case 2: recommendation within budget',
    'acme-customer-ana',
    'Recomiéndame una notebook de desarrollo por menos de USD 1.500',
    (c) =>
      c.status === 'COMPLETED' &&
      c.outcome === 'ANSWERED' &&
      (c.summary ?? '').includes('NB-DEV-32'),
  );
  const stockBefore = stock();
  await runCase(
    'demo_case3_inventory_ms',
    'case 3: inventory discrepancy explained for the operator',
    'acme-inventory',
    'Explícame la discrepancia de inventario de NB-DEV-32',
    (c) => c.status === 'COMPLETED' && (c.findings ?? []).some((f) => f.specialist === 'inventory'),
  );
  check('case 3 is read-only: no stock balance changed', stock() === stockBefore);

  // Approval: Ben asks to cancel, confirms, a different person approves, the run executes once.
  psql(
    `INSERT INTO commerce.orders (tenant_id, id, customer_id, status, currency, subtotal_minor, tax_minor, shipping_minor, total_minor) VALUES ('00000000-0000-4000-8000-000000000001', '${BEN_ORDER}', '${BEN}', 'CONFIRMED', 'USD', 2900, 0, 0, 2900)`,
  );
  const orderBefore = psql(
    `SELECT status || ':' || version FROM commerce.orders WHERE id = '${BEN_ORDER}'`,
  );
  const approvalStarted = performance.now();
  const run = await call('acme-customer-ben', '/v1/agent-runs', {
    method: 'POST',
    body: JSON.stringify({ message: `Quiero solicitar la cancelación del pedido ${BEN_ORDER}` }),
  });
  const runId = run.body.id;
  const waiting = await readEvents(
    'acme-customer-ben',
    runId,
    (e) => e.type === 'approval_required',
  );
  const proposal = waiting.find((e) => e.type === 'approval_required')?.proposal;
  check(
    'approval: the run stops in WAITING_HUMAN with a proposal',
    proposal?.order_id === BEN_ORDER,
    proposal
      ? `order ${orderBefore}, expected_version ${proposal.expected_version}`
      : `order ${orderBefore}, no proposal`,
  );
  const confirm = () =>
    call('acme-customer-ben', '/v1/action-requests', {
      method: 'POST',
      headers: { 'idempotency-key': `demo-confirm-${runId}` },
      body: JSON.stringify({
        order_id: proposal?.order_id,
        reason_code: proposal?.reason_code,
        expected_version: proposal?.expected_version,
        run_id: runId,
      }),
    });
  const first = await confirm();
  const replayed = await confirm();
  check(
    'approval: the confirmation creates one PENDING request',
    first.status === 201 && first.body.status === 'PENDING',
    `${first.status} ${first.body.status ?? first.body.code}`,
  );
  check(
    'replay: repeating the confirmation with the same idempotency key returns the same request',
    replayed.body.id === first.body.id &&
      psql(`SELECT count(*) FROM commerce.action_requests WHERE run_id = '${runId}'`) === '1',
  );
  const self = await call('acme-customer-ben', `/v1/approvals/${first.body.id}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'APPROVED' }),
  });
  check(
    'approval: the requester cannot approve',
    self.status >= 400,
    `${self.status} ${self.body.code ?? ''}`,
  );
  const decision = await call('acme-approver', `/v1/approvals/${first.body.id}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision: 'APPROVED', reason: 'demo' }),
  });
  check(
    'approval: a different approver approves',
    decision.status < 300,
    `${decision.status} ${decision.body.status ?? decision.body.code}`,
  );
  const all = await readEvents('acme-customer-ben', runId, (e) => e.type === 'completed');
  const done = all.find((e) => e.type === 'completed');
  timings.demo_approval_end_to_end_ms = performance.now() - approvalStarted;
  check(
    'approval: the run resumes and reports the action as requested',
    done?.outcome === 'ACTION_EXECUTED',
    done ? `${done.status}/${done.outcome}` : 'not completed',
  );
  check(
    'approval: the order is CANCELLATION_REQUESTED, with exactly one execution',
    psql(`SELECT status FROM commerce.orders WHERE id = '${BEN_ORDER}'`) ===
      'CANCELLATION_REQUESTED' &&
      psql(
        `SELECT count(*) FROM commerce.action_executions WHERE action_request_id = '${first.body.id}'`,
      ) === '1',
  );
  const trail = await call('acme-approver', `/v1/action-requests/${first.body.id}/trail`);
  check(
    'approval: the trail shows request, approval, execution and audit',
    trail.status === 200 &&
      trail.body.approval &&
      trail.body.execution &&
      trail.body.audit?.length > 0,
  );

  // Replay of the event stream: reconnecting after seq N returns only later events and no new run.
  const runsBefore = psql('SELECT count(*) FROM commerce.agent_runs');
  const pivot = all[1]?.seq ?? 0;
  const again = await readEvents('acme-customer-ben', runId, (e) => e.type === 'completed', {
    lastEventId: pivot,
  });
  check(
    'replay: Last-Event-ID resumes after the given event and starts no run',
    again.length > 0 &&
      again.every((e) => e.seq > pivot) &&
      again.at(-1)?.type === 'completed' &&
      psql('SELECT count(*) FROM commerce.agent_runs') === runsBefore,
    `${again.length} events after seq ${pivot}`,
  );
} catch (error) {
  check('demo completed', false, error instanceof Error ? error.message : String(error));
}

const path = await writeRunReport({
  suite: 'm11-demo',
  description: `compose.prod.yaml behind Caddy TLS at ${base}; deterministic template provider (no LLM)`,
  startedAt,
  checks,
  timings,
  source: 'infra/scripts/demo.mjs',
});
console.log(`\nReport: ${path}`);
process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
