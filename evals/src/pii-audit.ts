import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { buildReport, observed, type EvalReport } from './report.js';

/**
 * Places where operational data is persisted outside the customer record. Customer emails must
 * only exist encrypted in customers; secrets and card numbers must not appear anywhere.
 */
const TEXT_SOURCES: readonly { name: string; sql: string }[] = [
  { name: 'run_events', sql: 'SELECT data::text AS t FROM commerce.run_events' },
  {
    name: 'audit_events',
    sql: "SELECT concat_ws(' ', actor_subject_id, action, resource_type, correlation_id) AS t FROM commerce.audit_events",
  },
  {
    name: 'evidence',
    sql: "SELECT concat_ws(' ', kind, resource_ref, version) AS t FROM commerce.evidence",
  },
  {
    name: 'idempotency_records',
    sql: 'SELECT response::text AS t FROM commerce.idempotency_records',
  },
  { name: 'outbox', sql: 'SELECT payload::text AS t FROM commerce.outbox' },
  { name: 'tickets', sql: 'SELECT summary AS t FROM commerce.tickets' },
  {
    name: 'graph_checkpoints',
    sql: "SELECT convert_from(checkpoint, 'UTF8') AS t FROM commerce.graph_checkpoints",
  },
];

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** Luhn check: separates real-looking card numbers from long digit runs such as ids or amounts. */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

const PATTERNS: readonly { kind: string; test: (text: string) => boolean }[] = [
  { kind: 'email', test: (t) => /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(t) },
  {
    // UUIDs are removed first: the synthetic fixture ids are all-digit UUIDs, not card numbers.
    kind: 'card_number',
    test: (t) =>
      [...t.replace(UUID, ' ').matchAll(/\b(?:\d[ -]?){12,18}\d\b/g)].some((m) => {
        const digits = m[0].replace(/[ -]/g, '');
        return digits.length >= 13 && digits.length <= 19 && luhn(digits);
      }),
  },
  {
    kind: 'bearer_token',
    test: (t) => /Bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(t),
  },
  { kind: 'private_key', test: (t) => /"d"\s*:\s*"[A-Za-z0-9_-]{20,}"/.test(t) },
];

/** Kinds of sensitive content found in a text (empty when clean). */
export function sensitiveKinds(text: string): string[] {
  return PATTERNS.filter((p) => p.test(text)).map((p) => p.kind);
}

/** Agent runs keep the user's free text until retention erases it after 30 days. */
const RUN_INPUT_SQL = 'SELECT input::text AS t FROM commerce.agent_runs';

export async function runPiiAudit(adminUrl: string, root: string): Promise<EvalReport> {
  const startedAt = new Date();
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  const findings: string[] = [];
  let scanned = 0;
  let encryptedOk: number;
  let customers: number;
  try {
    for (const source of TEXT_SOURCES) {
      for (const row of (await client.query<{ t: string | null }>(source.sql)).rows) {
        scanned += 1;
        for (const p of PATTERNS)
          if (row.t && p.test(row.t)) findings.push(`${source.name}:${p.kind}`);
      }
    }
    // No stored ciphertext may contain any fixture address in clear.
    const seed = JSON.parse(
      await readFile(
        join(root, 'evals', 'fixtures', 'commerce-domain', '0.3.0', 'seed.json'),
        'utf8',
      ),
    ) as { customers: { email: string }[] };
    const emails = seed.customers.map((c) => c.email);
    const rows = (
      await client.query<{ ok: boolean }>(
        `SELECT NOT EXISTS (
           SELECT 1 FROM unnest($1::text[]) e
           WHERE position(convert_to(e, 'UTF8') IN c.email_ciphertext) > 0) AS ok
         FROM commerce.customers c`,
        [emails],
      )
    ).rows;
    customers = rows.length;
    encryptedOk = rows.filter((r) => r.ok).length;
    const runInputs = (await client.query<{ t: string }>(RUN_INPUT_SQL)).rows.filter((r) =>
      PATTERNS[0]?.test(r.t),
    ).length;
    // Structured logs of the last smoke run, if present: no tokens, cookies or emails.
    let logLines = 0;
    let logFindings = 0;
    const smokeDir = join(root, '.smoke');
    if (existsSync(smokeDir)) {
      const runs = (await readdir(smokeDir)).filter((d) => d.startsWith('smoke-')).sort();
      const lastRun = runs.at(-1);
      if (lastRun) {
        for (const file of (await readdir(join(smokeDir, lastRun))).filter((f) =>
          f.endsWith('.log'),
        )) {
          for (const line of (await readFile(join(smokeDir, lastRun, file), 'utf8')).split('\n')) {
            if (!line.trim()) continue;
            logLines += 1;
            if (PATTERNS.some((p) => p.test(line)) || /"cookie":"(?!\[Redacted\])/.test(line))
              logFindings += 1;
          }
        }
      }
    }
    const source = 'evals/src/pii-audit.ts';
    return buildReport({
      suite: 'pii-audit',
      target: {
        id: 'local-database+logs',
        mode: 'real',
        description:
          'Scan of persisted run, audit, evidence, idempotency, outbox, ticket and checkpoint data, customer email storage and the latest smoke logs',
      },
      startedAt,
      results: [
        observed('MEASURED', {
          metric: 'pii_in_operational_data',
          dimension: 'audit_redaction',
          unit: 'count',
          source,
          value: findings.length,
          denominator: Math.max(1, scanned),
          threshold: { operator: '==', value: 0 },
          notes: findings.length
            ? `Found: ${[...new Set(findings)].join(', ')}`
            : `No email, card number, bearer token or private key in ${String(scanned)} rows.`,
        }),
        observed('MEASURED', {
          metric: 'customer_email_encrypted',
          dimension: 'audit_redaction',
          unit: 'ratio',
          source,
          value: customers === 0 ? 1 : encryptedOk / customers,
          numerator: encryptedOk,
          denominator: Math.max(1, customers),
          threshold: { operator: '==', value: 1 },
        }),
        observed('MEASURED', {
          metric: 'secrets_in_logs',
          dimension: 'audit_redaction',
          unit: 'count',
          source,
          value: logFindings,
          denominator: Math.max(1, logLines),
          threshold: { operator: '==', value: 0 },
          notes: logLines
            ? `${String(logLines)} JSON log lines of the latest smoke run.`
            : 'No smoke logs present; run pnpm smoke first.',
        }),
        observed('MEASURED', {
          metric: 'run_inputs_with_email',
          dimension: 'audit_redaction',
          unit: 'count',
          source,
          value: runInputs,
          denominator: 1,
          notes:
            'User free text kept in agent_runs.input until the 30-day retention erases it (pnpm db:retention); reported, not gated.',
        }),
      ],
    });
  } finally {
    await client.end();
  }
}
