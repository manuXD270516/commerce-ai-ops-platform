import { join } from 'node:path';
import pg from 'pg';
import {
  DEFAULT_BUDGETS,
  EMPTY_USAGE,
  FIXTURES,
  POLICY_VERSION,
  createAgentRun,
  createDb,
  createPool,
  hashEmbedder,
  seedCommerceDomain,
  seedKnowledgeCorpus,
  type ActorContext,
} from '@commerce/domain';
import {
  Meter,
  ToolGateway,
  recommendProductsForRun,
  routeMessage,
  type Slots,
} from '@commerce/ai';
import { loadDataset } from './fixtures.js';
import { buildReport, observed, type EvalReport } from './report.js';

export interface SeedUrls {
  readonly adminUrl: string;
  readonly migratorUrl: string;
  readonly runtimeUrl: string;
  readonly piiKey: string;
}

const ana: ActorContext = {
  tenantId: FIXTURES.tenants.acme,
  subjectId: FIXTURES.subjects.ana,
  role: 'customer',
  customerId: FIXTURES.customers.ana,
  policyVersion: POLICY_VERSION,
};

/** nDCG@k with graded relevance (2^rel - 1 gains); the ideal ranking comes from the labels. */
export function ndcgAt(
  k: number,
  ranked: readonly string[],
  grades: Readonly<Record<string, number>>,
): number {
  const gain = (rel: number) => 2 ** rel - 1;
  const dcg = ranked
    .slice(0, k)
    .reduce((sum, sku, i) => sum + gain(grades[sku] ?? 0) / Math.log2(i + 2), 0);
  const ideal = Object.values(grades)
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((sum, rel, i) => sum + gain(rel) / Math.log2(i + 2), 0);
  return ideal === 0 ? 0 : dcg / ideal;
}

/**
 * Independent eligibility check in SQL, written separately from the specialist: published, USD,
 * tenant, region stock > 0, and the hard constraints parsed from the query.
 */
async function eligible(client: pg.Client, sku: string, slots: Slots): Promise<boolean> {
  const { rows } = await client.query<{ ok: boolean }>(
    `SELECT bool_and(
              p.status = 'published' AND s.currency = 'USD' AND p.category = $3
              AND ($4::bigint IS NULL OR s.price_minor < $4::bigint)
              AND ($5::bigint IS NULL OR s.price_minor <= $5::bigint)
              AND ($6::int IS NULL OR s.ram_gb = $6::int)
            ) AND sum(b.on_hand - b.reserved) FILTER (WHERE w.region = 'us-east') > 0 AS ok
       FROM commerce.skus s
       JOIN commerce.products p ON p.tenant_id = s.tenant_id AND p.id = s.product_id
       JOIN commerce.stock_balances b ON b.tenant_id = s.tenant_id AND b.sku_id = s.id
       JOIN commerce.warehouses w ON w.tenant_id = b.tenant_id AND w.id = b.warehouse_id
      WHERE s.tenant_id = $1 AND s.sku_code = $2`,
    [
      FIXTURES.tenants.acme,
      sku,
      slots.category ?? 'notebook',
      slots.budget?.operator === 'lt' ? slots.budget.minor : null,
      slots.budget?.operator === 'lte' ? slots.budget.minor : null,
      slots.ramGb ?? null,
    ],
  );
  return rows[0]?.ok === true;
}

export async function runRecommendationSuite(
  fixturesRoot: string,
  urls: SeedUrls,
): Promise<EvalReport> {
  const dataset = await loadDataset(join(fixturesRoot, 'recommendation', '0.1.0'));
  const startedAt = new Date();
  // Evals own the local database state: the catalog and corpus go back to their fixtures.
  await seedCommerceDomain(urls.migratorUrl, urls.piiKey);
  const db = createDb(createPool(urls.runtimeUrl));
  const client = new pg.Client({ connectionString: urls.adminUrl });
  await client.connect();
  try {
    await seedKnowledgeCorpus(db, hashEmbedder());
    const ndcgs: number[] = [];
    const misses: string[] = [];
    let recommended = 0;
    let eligibleCount = 0;
    let abstainExpected = 0;
    let abstainCorrect = 0;
    for (const c of dataset.cases) {
      const message = (c.input as { message: string }).message;
      const expected = c.expected as { grades: Record<string, number>; no_candidates: boolean };
      const slots = routeMessage(message).slots;
      const run = await createAgentRun(db, ana, {
        message,
        promptVersion: 'synth.v1',
        modelVersion: 'template-synth.v1',
        routerVersion: 'router.v1',
      });
      const finding = await recommendProductsForRun(
        {
          db,
          ctx: ana,
          gateway: new ToolGateway(db, ana, run.id, new Meter(DEFAULT_BUDGETS, EMPTY_USAGE)),
          embedder: hashEmbedder(),
          region: 'us-east',
          locale: 'es',
        },
        message,
        slots,
      );
      const ranked = (finding.items ?? []).map((i) => i.skuCode);
      for (const sku of ranked) {
        recommended += 1;
        if (await eligible(client, sku, slots)) eligibleCount += 1;
      }
      if (expected.no_candidates) {
        abstainExpected += 1;
        if (ranked.length === 0 && finding.status === 'no_candidates') abstainCorrect += 1;
        else misses.push(`${c.id}: expected no candidates, got ${ranked.join(',')}`);
      } else {
        const score = ndcgAt(3, ranked, expected.grades);
        ndcgs.push(score);
        if (score < 1)
          misses.push(`${c.id}: nDCG@3 ${score.toFixed(3)} for ${ranked.join(',') || '∅'}`);
      }
    }
    const mean = ndcgs.reduce((a, b) => a + b, 0) / ndcgs.length;
    const common = {
      dimension: 'recommendation_relevance',
      source: 'packages/ai/src/graph/specialists.ts#recommendProductsForRun',
    };
    return buildReport({
      suite: 'recommendation',
      target: {
        id: 'recommendation-specialist.v1',
        mode: 'real',
        description:
          'Recommendation specialist executed in-process against local PostgreSQL through the tool gateway (search_products, product documentation retrieval, check_inventory revalidation). No LLM.',
      },
      startedAt,
      results: [
        observed('MEASURED', {
          ...common,
          metric: 'recommendation_ndcg_at_3',
          unit: 'ratio',
          value: Number(mean.toFixed(3)),
          denominator: ndcgs.length,
          notes: `Queries with at least one eligible SKU. ${misses.length ? `Below 1: ${misses.join('; ')}` : 'All queries at 1.'} Gate 0.85 is EXPECTED until M10.`,
        }),
        observed('MEASURED', {
          ...common,
          metric: 'recommendation_eligible_ratio',
          unit: 'ratio',
          value: recommended === 0 ? 0 : Number((eligibleCount / recommended).toFixed(3)),
          numerator: eligibleCount,
          denominator: recommended,
          threshold: { operator: '==', value: 1 },
          notes: 'Every recommended SKU re-checked with an independent SQL predicate.',
        }),
        observed('MEASURED', {
          ...common,
          metric: 'recommendation_no_candidate_accuracy',
          unit: 'ratio',
          value: abstainExpected === 0 ? 0 : Number((abstainCorrect / abstainExpected).toFixed(3)),
          numerator: abstainCorrect,
          denominator: abstainExpected,
          threshold: { operator: '==', value: 1 },
          notes:
            'Queries with no eligible SKU must report no candidates instead of relaxing constraints.',
        }),
      ],
      dataset: {
        id: dataset.manifest.id,
        version: dataset.manifest.version,
        sha256: dataset.sha256,
        cases: dataset.cases.length,
      },
    });
  } finally {
    await client.end();
    await db.destroy();
  }
}
