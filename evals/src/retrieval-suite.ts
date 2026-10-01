import { join } from 'node:path';
import pg from 'pg';
import {
  CONTEXT_K,
  FIXTURES,
  POLICY_VERSION,
  RETRIEVAL_STRATEGIES,
  createDb,
  createPool,
  hashEmbedder,
  searchKnowledge,
  seedKnowledgeCorpus,
  type ActorContext,
  type DomainDb,
  type Embedder,
  type RetrievalStrategy,
} from '@commerce/domain';
import { loadDataset, type LoadedDataset } from './fixtures.js';
import { buildReport, observed, type EvalReport, type EvalResult } from './report.js';
import {
  distinctInOrder,
  scoreRetrieval,
  type RankedCase,
  type RetrievalCase,
} from './retrieval.js';

export interface DbUrls {
  readonly adminUrl: string;
  readonly runtimeUrl: string;
}

const ACME = FIXTURES.tenants.acme;

function actorFor(role: string): ActorContext {
  const base = { tenantId: ACME, policyVersion: POLICY_VERSION };
  if (role === 'customer') {
    return {
      ...base,
      role: 'customer',
      subjectId: FIXTURES.subjects.ana,
      customerId: FIXTURES.customers.ana,
    };
  }
  if (role === 'support')
    return { ...base, role: 'support', subjectId: FIXTURES.subjects.acmeSupport };
  throw new Error(`Unsupported role in retrieval fixture: ${role}`);
}

function toCase(raw: LoadedDataset['cases'][number]): RetrievalCase {
  const input = raw.input as { role: string; query: string };
  const expected = raw.expected as { relevant: string[]; forbidden?: string[] };
  return {
    id: raw.id,
    role: input.role,
    query: input.query,
    relevant: expected.relevant,
    forbidden: expected.forbidden ?? [],
  };
}

/**
 * Resets the knowledge tables to the fixture corpus. Evals own this local database state the same
 * way `pnpm db:seed` does; it never runs against anything but the configured local database.
 */
async function resetCorpus(adminUrl: string, db: DomainDb, embedder: Embedder): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    // Earlier runs may cite document versions; this local reset detaches those citations.
    await admin.query(
      'UPDATE commerce.evidence SET document_version_id = NULL WHERE document_version_id IS NOT NULL',
    );
    for (const table of ['retrieval_cache', 'chunks', 'document_versions', 'documents']) {
      await admin.query(`DELETE FROM commerce.${table}`);
    }
  } finally {
    await admin.end();
  }
  await seedKnowledgeCorpus(db, embedder);
}

async function rank(
  db: DomainDb,
  embedder: Embedder,
  cases: readonly RetrievalCase[],
  strategy: RetrievalStrategy,
): Promise<RankedCase[]> {
  const ranked: RankedCase[] = [];
  for (const c of cases) {
    const started = performance.now();
    const result = await searchKnowledge(db, actorFor(c.role), embedder, {
      query: c.query,
      strategy,
    });
    ranked.push({
      case: c,
      ranked: distinctInOrder(result.hits.map((h) => h.citation.sourceUri)),
      latencyMs: performance.now() - started,
    });
  }
  return ranked;
}

/**
 * Brute-force cosine ranking over the same authorized subset, computed outside PostgreSQL. It is
 * the exact baseline the SQL vector ranking must reproduce while no approximate index exists.
 */
async function exactBaselineOverlap(
  adminUrl: string,
  db: DomainDb,
  embedder: Embedder,
  cases: readonly RetrievalCase[],
): Promise<{ overlap: number; compared: number }> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  let found = 0;
  let compared = 0;
  try {
    const { rows } = await admin.query<{ id: string; embedding: string; acl: string[] }>(
      `SELECT c.id, c.embedding::text AS embedding, v.acl
         FROM commerce.chunks c
         JOIN commerce.document_versions v ON v.tenant_id = c.tenant_id AND v.id = c.document_version_id
        WHERE c.tenant_id = $1 AND v.status = 'published' AND c.embedding_model = $2
          AND v.valid_from <= now() AND (v.valid_to IS NULL OR v.valid_to > now())`,
      [ACME, embedder.model],
    );
    // Stored float32 vectors, so the baseline and SQL compare the same numbers.
    const stored = new Map(rows.map((r) => [r.id, JSON.parse(r.embedding) as number[]]));
    for (const c of cases) {
      const query = await embedder.embedQuery(c.query);
      const distance = (id: string) => 1 - cosine(query, stored.get(id) ?? []);
      const expected = rows
        .filter((row) => row.acl.includes('all') || row.acl.includes(c.role))
        .map((row) => distance(row.id))
        .sort((a, b) => a - b)
        .slice(0, CONTEXT_K);
      const actual = await searchKnowledge(db, actorFor(c.role), embedder, {
        query: c.query,
        strategy: 'vector',
      });
      const got = actual.hits.map((h) => distance(h.chunkId)).sort((a, b) => a - b);
      // Rank positions match when the distances agree; equal distances may legitimately swap ids.
      found += expected.filter((d, i) => Math.abs(d - (got[i] ?? Infinity)) < 1e-6).length;
      compared += expected.length;
    }
  } finally {
    await admin.end();
  }
  return { overlap: found, compared };
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  a.forEach((v, i) => {
    const w = b[i] ?? 0;
    dot += v * w;
    na += v * v;
    nb += w * w;
  });
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export async function runRetrievalSuites(
  fixturesRoot: string,
  urls: DbUrls,
): Promise<EvalReport[]> {
  const dataset = await loadDataset(join(fixturesRoot, 'knowledge', '0.1.0'));
  const embedder = hashEmbedder();
  const db = createDb(createPool(urls.runtimeUrl));
  const reports: EvalReport[] = [];
  try {
    await resetCorpus(urls.adminUrl, db, embedder);
    for (const split of ['dev', 'holdout'] as const) {
      const startedAt = new Date();
      const cases = dataset.cases.filter((c) => c.suite === split).map(toCase);
      const results: EvalResult[] = [];
      for (const strategy of RETRIEVAL_STRATEGIES) {
        const metrics = scoreRetrieval(await rank(db, embedder, cases, strategy), 'kb://acme/');
        const common = {
          dimension: 'retrieval_quality',
          source: 'packages/domain/src/knowledge.ts#searchKnowledge',
          denominator: metrics.cases,
        };
        results.push(
          observed('MEASURED', {
            ...common,
            metric: `retrieval_recall_at_5_${strategy}`,
            unit: 'ratio',
            value: metrics.recallAt5,
            notes: `Baseline, no gate in M4 (docs/rag-evals.md target 0.90 is checked in M10). Misses: ${metrics.misses.join(', ') || 'none'}.`,
          }),
          observed('MEASURED', {
            ...common,
            metric: `retrieval_mrr_at_5_${strategy}`,
            unit: 'ratio',
            value: metrics.mrrAt5,
          }),
          observed('MEASURED', {
            ...common,
            metric: `forbidden_source_hits_${strategy}`,
            dimension: 'unauthorized_action_rate',
            unit: 'count',
            value: metrics.forbiddenHits,
            threshold: { operator: '==', value: 0 },
            notes: 'Sources the role may not read (ACL) anywhere in the returned hits.',
          }),
          observed('MEASURED', {
            ...common,
            metric: `cross_tenant_hits_${strategy}`,
            dimension: 'unauthorized_action_rate',
            unit: 'count',
            value: metrics.crossTenantHits,
            threshold: { operator: '==', value: 0 },
          }),
          observed('MEASURED', {
            ...common,
            metric: `retrieval_latency_p95_${strategy}`,
            dimension: 'latency',
            unit: 'ms',
            value: metrics.p95Ms,
            notes: `p50 ${String(metrics.p50Ms)} ms; in-process call against local PostgreSQL, including the audit insert. Not a load test.`,
          }),
        );
      }
      if (split === 'dev') {
        const exact = await exactBaselineOverlap(urls.adminUrl, db, embedder, cases);
        results.push(
          observed('MEASURED', {
            metric: 'vector_recall_vs_exact_baseline',
            dimension: 'retrieval_quality',
            unit: 'ratio',
            source: 'evals/src/retrieval-suite.ts#exactBaselineOverlap',
            value: exact.compared === 0 ? 0 : Number((exact.overlap / exact.compared).toFixed(3)),
            numerator: exact.overlap,
            denominator: exact.compared,
            threshold: { operator: '==', value: 1 },
            notes: `Top-${String(CONTEXT_K)} distances from SQL exact search vs brute-force cosine in Node over the same authorized subset and stored vectors; ties may swap ids, so positions are compared by distance.`,
          }),
        );
      }
      reports.push(
        buildReport({
          suite: `retrieval-${split}`,
          target: {
            id: `searchKnowledge+${embedder.model}`,
            mode: 'real',
            description:
              'Hybrid retrieval in local PostgreSQL 17 + pgvector with the deterministic local-hash-v1 embedder; strategies fulltext, vector and hybrid over the same authorized subset',
          },
          startedAt,
          results,
          dataset: {
            id: dataset.manifest.id,
            version: dataset.manifest.version,
            sha256: dataset.sha256,
            cases: cases.length,
          },
        }),
      );
    }
  } finally {
    await db.destroy();
  }
  return reports;
}
