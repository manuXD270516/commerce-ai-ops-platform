import pg from 'pg';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';
import { startTracing } from '@commerce/telemetry';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FIXTURES,
  POLICY_VERSION,
  createAgentRun,
  createDb,
  createPool,
  hashEmbedder,
  migrate,
  seedCommerceDomain,
  seedKnowledgeCorpus,
} from '@commerce/domain';
import { TemplateSynthesizer, executeRun } from '../src/index.js';

const { DATABASE_ADMIN_URL, DATABASE_MIGRATOR_URL, DATABASE_URL, PII_ENCRYPTION_KEY } = process.env;
const enabled = Boolean(
  DATABASE_ADMIN_URL && DATABASE_MIGRATOR_URL && DATABASE_URL && PII_ENCRYPTION_KEY,
);

describe.skipIf(!enabled)('correlated traces and audit (M10)', () => {
  const exporter = new InMemorySpanExporter();
  const tracing = startTracing({ serviceName: 'ai-test', exporter, instrument: false });
  const db = createDb(createPool(DATABASE_URL!));
  const owner = new pg.Client({ connectionString: DATABASE_MIGRATOR_URL });

  beforeAll(async () => {
    await migrate({
      adminUrl: DATABASE_ADMIN_URL!,
      migratorUrl: DATABASE_MIGRATOR_URL!,
      runtimeUrl: DATABASE_URL!,
    });
    await seedCommerceDomain(DATABASE_MIGRATOR_URL!, PII_ENCRYPTION_KEY!);
    await seedKnowledgeCorpus(db, hashEmbedder());
    await owner.connect();
  }, 60_000);

  afterAll(async () => {
    await tracing.shutdown();
    await owner.end();
    await db.destroy();
  });

  it('links run, tool call and audit records through run_id, tool_call_id and correlation id', async () => {
    const ana = {
      tenantId: FIXTURES.tenants.acme,
      subjectId: FIXTURES.subjects.ana,
      role: 'customer' as const,
      customerId: FIXTURES.customers.ana,
      policyVersion: POLICY_VERSION,
    };
    const run = await createAgentRun(db, ana, {
      message: `¿Dónde está mi pedido ${FIXTURES.orders.anaPartial}?`,
      promptVersion: 'synth.v1',
      modelVersion: 'template-synth.v1',
      routerVersion: 'router.v1',
    });
    await executeRun(
      {
        db,
        embedder: hashEmbedder(),
        synthesizer: new TemplateSynthesizer(),
        workerId: 'trace-test',
      },
      FIXTURES.tenants.acme,
      run.id,
    );
    const spans = exporter.getFinishedSpans();
    const runSpan = spans.find((s) => s.name === 'agent.run');
    const toolSpans = spans.filter((s) => s.name === 'tool.call');
    expect(runSpan?.attributes['commerce.run_id']).toBe(run.id);
    expect(toolSpans.map((s) => s.attributes['commerce.tool'])).toEqual(
      expect.arrayContaining(['get_order', 'get_shipping_status']),
    );
    for (const span of toolSpans) {
      expect(span.attributes['commerce.run_id']).toBe(run.id);
      // Same trace as the run, child of it.
      expect(span.spanContext().traceId).toBe(runSpan?.spanContext().traceId);
    }
    const toolCallIds = toolSpans.map((s) => String(s.attributes['commerce.tool_call_id']));
    const audit = await owner.query<{ resource_id: string; correlation_id: string }>(
      `SELECT resource_id, correlation_id FROM commerce.audit_events WHERE resource_type = 'tool_call' AND resource_id = ANY($1::uuid[])`,
      [toolCallIds],
    );
    expect(audit.rows).toHaveLength(toolCallIds.length);
    expect(new Set(audit.rows.map((r) => r.correlation_id))).toEqual(new Set([`run-${run.id}`]));
    // Spans carry ids and outcomes, never message text or arguments.
    const serialized = JSON.stringify(spans.map((s) => s.attributes));
    expect(serialized).not.toContain('Dónde está mi pedido');
  });
});
