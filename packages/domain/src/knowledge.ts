import { createHash, randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { ActorContext, Role } from './access.js';
import { ROLES } from './access.js';
import { assertRole } from './actors.js';
import {
  CANDIDATE_K,
  CHUNK_MAX_TOKENS,
  CHUNK_OVERLAP_TOKENS,
  CONTEXT_K,
  EMBEDDING_DIM,
  MAX_RECOMMENDATIONS,
  RETRIEVAL_CACHE_TTL_MS,
  RRF_K,
} from './constants.js';
import type { Database } from './db.js';
import { checksumOf, vectorLiteral, type Embedder } from './embed.js';
import { DomainError } from './errors.js';
import { appendAudit, withUnitOfWork, type DomainTrx } from './uow.js';

export const DOCUMENT_KINDS = ['policy', 'faq', 'shipping', 'returns', 'product'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export type AclEntry = Role | 'all';

export interface IngestInput {
  readonly sourceUri: string;
  readonly kind: DocumentKind;
  readonly title: string;
  /** Markdown-like text; lines starting with "## " open a new section. */
  readonly body: string;
  readonly locale: string;
  readonly region: string;
  readonly validFrom: Date;
  readonly validTo?: Date;
  readonly productId?: string;
  readonly acl: readonly AclEntry[];
  /** Versions are drafts unless published here or later with publishDocumentVersion. */
  readonly publish?: boolean;
}

export interface IngestResult {
  readonly documentId: string;
  readonly versionId: string;
  readonly version: number;
  readonly checksum: string;
  readonly status: 'draft' | 'published' | 'retired';
  readonly chunks: number;
  readonly duplicate: boolean;
}

export interface Citation {
  readonly documentVersionId: string;
  readonly sourceUri: string;
  readonly title: string;
  readonly kind: string;
  readonly version: number;
  readonly section: string;
  readonly validFrom: string;
  readonly validTo: string | null;
}

/**
 * Retrieved text is data from the corpus, never an instruction: it cannot add tools, scopes or
 * mutations, whatever it says. Callers must keep it out of any authorization decision.
 */
export interface RetrievalHit {
  readonly chunkId: string;
  readonly score: number;
  readonly text: string;
  readonly trust: 'untrusted_corpus_text';
  readonly citation: Citation;
}

export interface KnowledgeQuery {
  readonly query: string;
  readonly kind?: DocumentKind;
  readonly region?: string;
  readonly locale?: string;
  /** Point in time for validity; defaults to now. */
  readonly at?: Date;
  readonly productIds?: readonly string[];
  /**
   * Ranking over the already-authorized subset. hybrid (default) fuses both lists with RRF; the
   * single-signal strategies exist for the M4 spike baselines and never widen the subset.
   */
  readonly strategy?: RetrievalStrategy;
}

export const RETRIEVAL_STRATEGIES = ['hybrid', 'vector', 'fulltext'] as const;
export type RetrievalStrategy = (typeof RETRIEVAL_STRATEGIES)[number];

export interface KnowledgeResult {
  readonly status: 'OK' | 'NO_EVIDENCE';
  readonly hits: readonly RetrievalHit[];
  readonly cached: boolean;
  readonly corpusVersion: string;
  readonly embeddingModel: string;
}

const MAX_QUERY_CHARS = 1000;

export async function ingestDocument(
  db: Kysely<Database>,
  ctx: ActorContext,
  embedder: Embedder,
  input: IngestInput,
): Promise<IngestResult> {
  assertRole(ctx, ['admin']);
  validateIngest(input);
  assertEmbedder(embedder);
  const checksum = checksumOf(canonicalContent(input));

  const existing = await withUnitOfWork(db, ctx, (trx) =>
    findByChecksum(trx, input.sourceUri, checksum),
  );
  if (existing) return existing;

  const chunks = chunkDocument(input.title, input.body);
  const vectors = await embedder.embedDocuments(chunks.map((c) => c.text));
  if (vectors.length !== chunks.length || vectors.some((v) => v.length !== EMBEDDING_DIM)) {
    throw new DomainError('DEPENDENCY_UNAVAILABLE', 'Embedder returned malformed vectors');
  }

  return withUnitOfWork(db, ctx, async (trx) => {
    await trx
      .insertInto('documents')
      .values({
        tenant_id: ctx.tenantId,
        id: randomUUID(),
        kind: input.kind,
        source_uri: input.sourceUri,
        product_id: input.productId ?? null,
        title: input.title,
      })
      .onConflict((oc) => oc.columns(['tenant_id', 'source_uri']).doNothing())
      .execute();
    const document = await trx
      .selectFrom('documents')
      .selectAll()
      .where('source_uri', '=', input.sourceUri)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (document.kind !== input.kind || document.product_id !== (input.productId ?? null)) {
      throw new DomainError('VALIDATION_ERROR', 'A source keeps its kind and product', {
        field: 'sourceUri',
      });
    }
    const raced = await findByChecksum(trx, input.sourceUri, checksum);
    if (raced) return raced;

    const latest = await trx
      .selectFrom('document_versions')
      .select(({ fn }) => fn.max('version').as('version'))
      .where('document_id', '=', document.id)
      .executeTakeFirst();
    const version = (latest?.version ?? 0) + 1;
    const versionId = randomUUID();
    const status = input.publish === true ? 'published' : 'draft';
    await trx
      .updateTable('documents')
      .set({ title: input.title })
      .where('id', '=', document.id)
      .execute();
    await trx
      .insertInto('document_versions')
      .values({
        tenant_id: ctx.tenantId,
        id: versionId,
        document_id: document.id,
        checksum,
        version,
        status,
        locale: input.locale,
        region: input.region,
        valid_from: input.validFrom,
        valid_to: input.validTo ?? null,
        acl: JSON.stringify([...new Set(input.acl)].sort()),
        published_at: status === 'published' ? new Date() : null,
        retired_at: null,
      })
      .execute();
    for (const [ordinal, chunk] of chunks.entries()) {
      await sql`
        INSERT INTO commerce.chunks
          (tenant_id, id, document_version_id, ordinal, body, section, token_count,
           embedding, embedding_model)
        VALUES (
          ${ctx.tenantId}::uuid, ${randomUUID()}::uuid, ${versionId}::uuid, ${ordinal},
          ${chunk.text}, ${chunk.section}, ${chunk.tokens},
          ${vectorLiteral(vectors[ordinal] ?? [])}::vector, ${embedder.model}
        )
      `.execute(trx);
    }
    if (status === 'published') await invalidateCache(trx);
    await appendAudit(trx, ctx, {
      action: 'knowledge.ingest',
      resourceType: 'document_version',
      resourceId: versionId,
      outcome: 'ALLOWED',
    });
    return {
      documentId: document.id,
      versionId,
      version,
      checksum,
      status,
      chunks: chunks.length,
      duplicate: false,
    };
  });
}

export async function publishDocumentVersion(
  db: Kysely<Database>,
  ctx: ActorContext,
  versionId: string,
): Promise<void> {
  await transition(db, ctx, versionId, 'draft', 'published');
}

/**
 * Retired versions leave retrieval and the cache at once but stay in the database, so citations
 * already given remain resolvable through getDocumentVersion.
 */
export async function retireDocumentVersion(
  db: Kysely<Database>,
  ctx: ActorContext,
  versionId: string,
): Promise<void> {
  await transition(db, ctx, versionId, 'published', 'retired');
}

export async function getDocumentVersion(
  db: Kysely<Database>,
  ctx: ActorContext,
  versionId: string,
): Promise<Citation & { status: string; checksum: string }> {
  return withUnitOfWork(db, ctx, async (trx) => {
    const row = await trx
      .selectFrom('document_versions as v')
      .innerJoin('documents as d', (j) =>
        j.onRef('d.id', '=', 'v.document_id').onRef('d.tenant_id', '=', 'v.tenant_id'),
      )
      .select([
        'v.id',
        'v.version',
        'v.status',
        'v.checksum',
        'v.valid_from',
        'v.valid_to',
        'v.acl',
        'd.source_uri',
        'd.title',
        'd.kind',
      ])
      .where('v.id', '=', versionId)
      .executeTakeFirst();
    if (!row || !aclAllows(row.acl, ctx.role)) {
      throw new DomainError('NOT_FOUND', 'Document version not found');
    }
    return {
      documentVersionId: row.id,
      sourceUri: row.source_uri,
      title: row.title,
      kind: row.kind,
      version: row.version,
      section: '',
      validFrom: row.valid_from.toISOString(),
      validTo: row.valid_to?.toISOString() ?? null,
      status: row.status,
      checksum: row.checksum,
    };
  });
}

/**
 * Hybrid retrieval over the authorized subset only: tenant (RLS), ACL, publication, validity and
 * structured filters run first; exact vector distance and full-text ranks are then fused with RRF.
 */
export async function searchKnowledge(
  db: Kysely<Database>,
  ctx: ActorContext,
  embedder: Embedder,
  input: KnowledgeQuery,
): Promise<KnowledgeResult> {
  const query = validateQuery(input.query);
  assertEmbedder(embedder);
  const vector = await embedder.embedQuery(query);
  return withUnitOfWork(db, ctx, async (trx) => {
    const corpusVersion = await corpusVersionOf(trx, embedder.model);
    const cacheKey = hashJson({
      model: embedder.model,
      role: ctx.role,
      query: query.toLowerCase(),
      kind: input.kind ?? null,
      region: input.region ?? null,
      locale: input.locale ?? null,
      at: input.at?.toISOString() ?? null,
      productIds: [...(input.productIds ?? [])].sort(),
      strategy: input.strategy ?? 'hybrid',
    });
    const cached = await trx
      .selectFrom('retrieval_cache')
      .select('payload')
      .where('cache_key', '=', cacheKey)
      .where('corpus_version', '=', corpusVersion)
      .where('expires_at', '>', new Date())
      .executeTakeFirst();
    let hits: RetrievalHit[];
    if (cached) {
      hits = cached.payload as RetrievalHit[];
    } else {
      hits = (await hybridSearch(trx, ctx, embedder.model, vector, query, input)).map(
        ({ productId: _productId, ...hit }) => hit,
      );
      await trx
        .insertInto('retrieval_cache')
        .values({
          tenant_id: ctx.tenantId,
          cache_key: cacheKey,
          payload: JSON.stringify(hits),
          corpus_version: corpusVersion,
          expires_at: await cacheExpiry(trx, input.at),
        })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'cache_key']).doUpdateSet((eb) => ({
            payload: eb.ref('excluded.payload'),
            corpus_version: eb.ref('excluded.corpus_version'),
            expires_at: eb.ref('excluded.expires_at'),
          })),
        )
        .execute();
    }
    await appendAudit(trx, ctx, {
      action: 'knowledge.search',
      resourceType: 'chunk',
      outcome: 'ALLOWED',
    });
    return {
      status: hits.length > 0 ? 'OK' : 'NO_EVIDENCE',
      hits,
      cached: cached !== undefined,
      corpusVersion,
      embeddingModel: embedder.model,
    };
  });
}

export type PolicySelection =
  | {
      readonly status: 'APPLICABLE';
      readonly purchasedAt: string;
      readonly policy: Citation;
      readonly excerpt: string;
    }
  | {
      readonly status: 'ABSTAIN';
      readonly reason: 'NO_APPLICABLE_POLICY' | 'CONFLICTING_POLICIES';
      readonly purchasedAt: string;
      readonly candidates: readonly Citation[];
    };

/**
 * Picks the policy in force when the order was placed, not the latest one. Versions of the same
 * source supersede each other; two different sources in force at once have no precedence rule,
 * so the answer abstains instead of choosing one.
 */
export async function selectApplicablePolicy(
  db: Kysely<Database>,
  ctx: ActorContext,
  input: { orderId: string; kind: 'returns' | 'shipping'; region: string; locale: string },
): Promise<PolicySelection> {
  assertRole(ctx, ['customer', 'support', 'approver', 'admin']);
  return withUnitOfWork(db, ctx, async (trx) => {
    let orderQuery = trx
      .selectFrom('orders')
      .select(['id', 'created_at'])
      .where('id', '=', input.orderId);
    if (ctx.role === 'customer') {
      orderQuery = orderQuery.where('customer_id', '=', ctx.customerId ?? '');
    }
    const order = await orderQuery.executeTakeFirst();
    if (!order) {
      await appendAudit(trx, ctx, {
        action: 'knowledge.policy_for_order',
        resourceType: 'order',
        resourceId: input.orderId,
        outcome: 'DENIED',
      });
      throw new DomainError('NOT_FOUND', 'Order not found');
    }
    const at = order.created_at;
    const rows = await sql<{
      version_id: string;
      version: number;
      valid_from: Date;
      valid_to: Date | null;
      source_uri: string;
      title: string;
      kind: string;
      section: string | null;
      body: string | null;
    }>`
      SELECT DISTINCT ON (d.id)
             v.id AS version_id, v.version, v.valid_from, v.valid_to,
             d.source_uri, d.title, d.kind, c.section, c.body
      FROM commerce.document_versions v
      JOIN commerce.documents d ON d.tenant_id = v.tenant_id AND d.id = v.document_id
      LEFT JOIN commerce.chunks c
        ON c.tenant_id = v.tenant_id AND c.document_version_id = v.id AND c.ordinal = 0
      WHERE d.kind = ${input.kind}
        AND v.status = 'published'
        AND v.region = ${input.region}
        AND v.locale = ${input.locale}
        AND (v.acl ? ${ctx.role} OR v.acl ? 'all')
        AND v.valid_from <= ${at}
        AND (v.valid_to IS NULL OR v.valid_to > ${at})
      ORDER BY d.id, v.version DESC
    `.execute(trx);
    const candidates = rows.rows.map((r) => ({
      citation: {
        documentVersionId: r.version_id,
        sourceUri: r.source_uri,
        title: r.title,
        kind: r.kind,
        version: r.version,
        section: r.section ?? '',
        validFrom: r.valid_from.toISOString(),
        validTo: r.valid_to?.toISOString() ?? null,
      },
      excerpt: r.body ?? '',
    }));
    await appendAudit(trx, ctx, {
      action: 'knowledge.policy_for_order',
      resourceType: 'order',
      resourceId: order.id,
      outcome: 'ALLOWED',
    });
    const purchasedAt = at.toISOString();
    const only = candidates.length === 1 ? candidates[0] : undefined;
    if (only) {
      return {
        status: 'APPLICABLE',
        purchasedAt,
        policy: only.citation,
        excerpt: only.excerpt,
      };
    }
    return {
      status: 'ABSTAIN',
      reason: candidates.length === 0 ? 'NO_APPLICABLE_POLICY' : 'CONFLICTING_POLICIES',
      purchasedAt,
      candidates: candidates.map((c) => c.citation),
    };
  });
}

export interface RecommendationQuery {
  readonly query: string;
  readonly category: string;
  readonly currency: string;
  /** Strict upper bound in minor units: price_minor < priceLt. */
  readonly priceLt?: number;
  readonly ramGb?: number;
  readonly cpuFamily?: string;
  readonly region: string;
  readonly limit?: number;
}

export interface Recommendation {
  readonly skuId: string;
  readonly skuCode: string;
  readonly productId: string;
  readonly title: string;
  readonly priceMinor: number;
  readonly currency: string;
  readonly available: number;
  readonly region: string;
  readonly observedAt: string;
  /** hybrid: ranked with product documentation; sql_only: eligible but without documentation. */
  readonly ranking: 'hybrid' | 'sql_only';
  readonly score: number;
  readonly evidence: readonly Citation[];
}

export type RecommendationResult =
  | {
      readonly status: 'OK';
      readonly items: readonly Recommendation[];
      readonly observedAt: string;
      readonly notice: 'recommendation_not_reservation';
    }
  | {
      readonly status: 'NO_CANDIDATES';
      readonly observedAt: string;
      readonly filters: Omit<RecommendationQuery, 'query'>;
    };

/**
 * SQL decides eligibility (published, currency, strict budget, mandatory attributes, stock in the
 * region); semantic ranking only orders what SQL already allowed. With no eligible SKU the
 * constraints are reported unchanged instead of being relaxed.
 */
export async function recommendProducts(
  db: Kysely<Database>,
  ctx: ActorContext,
  embedder: Embedder,
  input: RecommendationQuery,
): Promise<RecommendationResult> {
  const query = validateQuery(input.query);
  if (input.currency !== 'USD') {
    throw new DomainError('VALIDATION_ERROR', 'Only USD is supported', { field: 'currency' });
  }
  for (const [field, value] of [
    ['price_lt', input.priceLt],
    ['ram_gb', input.ramGb],
    ['limit', input.limit],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new DomainError('VALIDATION_ERROR', `${field} must be a non-negative integer`, {
        field,
      });
    }
  }
  const limit = input.limit ?? MAX_RECOMMENDATIONS;
  if (limit < 1 || limit > MAX_RECOMMENDATIONS) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `limit must be between 1 and ${MAX_RECOMMENDATIONS}`,
      {
        field: 'limit',
      },
    );
  }
  assertEmbedder(embedder);
  const vector = await embedder.embedQuery(query);
  const observedAt = new Date().toISOString();
  return withUnitOfWork(db, ctx, async (trx) => {
    const eligible = await sql<{
      sku_id: string;
      sku_code: string;
      product_id: string;
      title: string;
      price_minor: string;
      currency: string;
      available: number;
      region: string;
    }>`
      SELECT s.id AS sku_id, s.sku_code, s.product_id, p.title, s.price_minor, s.currency,
             SUM(b.on_hand - b.reserved)::int AS available, w.region
      FROM commerce.skus s
      JOIN commerce.products p ON p.tenant_id = s.tenant_id AND p.id = s.product_id
      JOIN commerce.stock_balances b ON b.tenant_id = s.tenant_id AND b.sku_id = s.id
      JOIN commerce.warehouses w ON w.tenant_id = b.tenant_id AND w.id = b.warehouse_id
      WHERE p.status = 'published'
        AND p.category = ${input.category}
        AND s.currency = ${input.currency}
        AND w.region = ${input.region}
        AND (${input.priceLt ?? null}::bigint IS NULL OR s.price_minor < ${input.priceLt ?? null}::bigint)
        AND (${input.ramGb ?? null}::int IS NULL OR s.ram_gb = ${input.ramGb ?? null}::int)
        AND (${input.cpuFamily ?? null}::text IS NULL OR s.cpu_family = ${input.cpuFamily ?? null})
      GROUP BY s.id, s.sku_code, s.product_id, p.title, s.price_minor, s.currency, w.region
      HAVING SUM(b.on_hand - b.reserved) > 0
      ORDER BY s.sku_code
    `.execute(trx);
    await appendAudit(trx, ctx, {
      action: 'catalog.recommend',
      resourceType: 'product',
      outcome: 'ALLOWED',
    });
    if (eligible.rows.length === 0) {
      return { status: 'NO_CANDIDATES', observedAt, filters: withoutQuery(input) };
    }
    const productIds = [...new Set(eligible.rows.map((r) => r.product_id))];
    const hits = await hybridSearch(trx, ctx, embedder.model, vector, query, {
      kind: 'product',
      productIds,
    });
    const byProduct = new Map<string, { score: number; evidence: Citation[] }>();
    for (const hit of hits) {
      const productId = hit.productId;
      if (productId === null) continue;
      const entry = byProduct.get(productId) ?? { score: 0, evidence: [] };
      entry.score = Math.max(entry.score, hit.score);
      entry.evidence.push(hit.citation);
      byProduct.set(productId, entry);
    }
    const items: Recommendation[] = eligible.rows.map((r) => {
      const ranked = byProduct.get(r.product_id);
      return {
        skuId: r.sku_id,
        skuCode: r.sku_code,
        productId: r.product_id,
        title: r.title,
        priceMinor: Number(r.price_minor),
        currency: r.currency,
        available: r.available,
        region: r.region,
        observedAt,
        ranking: ranked ? 'hybrid' : 'sql_only',
        score: ranked?.score ?? 0,
        evidence: ranked?.evidence ?? [],
      };
    });
    items.sort((a, b) => b.score - a.score || a.skuCode.localeCompare(b.skuCode));
    return {
      status: 'OK',
      items: items.slice(0, limit),
      observedAt,
      notice: 'recommendation_not_reservation',
    };
  });
}

interface Chunk {
  readonly section: string;
  readonly text: string;
  readonly tokens: number;
}

/**
 * Splits by "## " sections and then by an approximate token budget (whitespace words) with a
 * bounded overlap; every chunk repeats its title and section heading.
 */
export function chunkDocument(title: string, body: string): Chunk[] {
  const sections: { heading: string; lines: string[] }[] = [{ heading: title, lines: [] }];
  for (const line of body.split(/\r?\n/)) {
    const heading = /^##\s+(.+)$/.exec(line);
    if (heading?.[1]) sections.push({ heading: heading[1].trim(), lines: [] });
    else sections[sections.length - 1]?.lines.push(line);
  }
  const chunks: Chunk[] = [];
  for (const section of sections) {
    const words = section.lines.join(' ').split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const step = CHUNK_MAX_TOKENS - CHUNK_OVERLAP_TOKENS;
    for (let start = 0; start < words.length; start += step) {
      const slice = words.slice(start, start + CHUNK_MAX_TOKENS);
      const prefix = section.heading === title ? title : `${title} — ${section.heading}`;
      chunks.push({
        section: section.heading,
        text: `${prefix}\n${slice.join(' ')}`,
        tokens: slice.length,
      });
      if (start + CHUNK_MAX_TOKENS >= words.length) break;
    }
  }
  if (chunks.length === 0) {
    throw new DomainError('VALIDATION_ERROR', 'Document has no content', { field: 'body' });
  }
  return chunks;
}

interface HybridHit extends RetrievalHit {
  readonly productId: string | null;
}

async function hybridSearch(
  trx: DomainTrx,
  ctx: ActorContext,
  model: string,
  vector: readonly number[],
  query: string,
  filters: Omit<KnowledgeQuery, 'query'>,
): Promise<HybridHit[]> {
  const at = filters.at ?? new Date();
  const tsquery = fullTextQuery(query);
  const productIds = filters.productIds ?? null;
  const strategy = filters.strategy ?? 'hybrid';
  if (!RETRIEVAL_STRATEGIES.includes(strategy)) {
    throw new DomainError('VALIDATION_ERROR', 'Unknown retrieval strategy', { field: 'strategy' });
  }
  const rows = await sql<{
    chunk_id: string;
    body: string;
    section: string;
    version_id: string;
    version: number;
    valid_from: Date;
    valid_to: Date | null;
    source_uri: string;
    title: string;
    kind: string;
    product_id: string | null;
    score: number;
  }>`
    WITH eligible AS MATERIALIZED (
      SELECT c.id, c.body, c.section, c.ordinal, c.embedding, c.tsv,
             v.id AS version_id, v.version, v.valid_from, v.valid_to,
             d.source_uri, d.title, d.kind, d.product_id
      FROM commerce.chunks c
      JOIN commerce.document_versions v
        ON v.tenant_id = c.tenant_id AND v.id = c.document_version_id
      JOIN commerce.documents d ON d.tenant_id = v.tenant_id AND d.id = v.document_id
      WHERE v.status = 'published'
        AND v.valid_from <= ${at}
        AND (v.valid_to IS NULL OR v.valid_to > ${at})
        AND (v.acl ? ${ctx.role} OR v.acl ? 'all')
        AND c.embedding_model = ${model}
        AND (${filters.kind ?? null}::text IS NULL OR d.kind = ${filters.kind ?? null})
        AND (${filters.region ?? null}::text IS NULL OR v.region = ${filters.region ?? null})
        AND (${filters.locale ?? null}::text IS NULL OR v.locale = ${filters.locale ?? null})
        AND (${productIds}::uuid[] IS NULL OR d.product_id = ANY(${productIds}::uuid[]))
    ),
    vec AS (
      SELECT id, row_number() OVER (ORDER BY embedding <=> ${vectorLiteral(vector)}::vector, source_uri, version, ordinal) AS r
      FROM eligible
      ORDER BY r
      LIMIT ${CANDIDATE_K}
    ),
    fts AS (
      SELECT id, row_number() OVER (
               ORDER BY ts_rank(tsv, to_tsquery('simple', ${tsquery})) DESC, source_uri, version, ordinal) AS r
      FROM eligible
      WHERE ${tsquery}::text <> '' AND tsv @@ to_tsquery('simple', ${tsquery})
      ORDER BY r
      LIMIT ${CANDIDATE_K}
    ),
    fused AS (
      SELECT id, SUM(1.0 / (${RRF_K} + r))::float8 AS score
      FROM (SELECT id, r FROM vec WHERE ${strategy !== 'fulltext'}
            UNION ALL
            SELECT id, r FROM fts WHERE ${strategy !== 'vector'}) ranks
      GROUP BY id
    )
    SELECT e.id AS chunk_id, e.body, e.section, e.version_id, e.version, e.valid_from,
           e.valid_to, e.source_uri, e.title, e.kind, e.product_id, f.score
    FROM fused f
    JOIN eligible e ON e.id = f.id
    ORDER BY f.score DESC, e.source_uri, e.version, e.ordinal
    LIMIT ${CONTEXT_K}
  `.execute(trx);
  return rows.rows.map((r) => ({
    chunkId: r.chunk_id,
    score: Number(r.score.toFixed(6)),
    text: r.body,
    trust: 'untrusted_corpus_text',
    productId: r.product_id,
    citation: {
      documentVersionId: r.version_id,
      sourceUri: r.source_uri,
      title: r.title,
      kind: r.kind,
      version: r.version,
      section: r.section,
      validFrom: r.valid_from.toISOString(),
      validTo: r.valid_to?.toISOString() ?? null,
    },
  }));
}

const STOPWORDS = new Set(
  'de la el los las un una unos unas del al en por para con sin que qué como cómo es son se mi mis tu su sus lo le les y o u a ya me te nos hay tengo puedo cual cuál cuanto cuánto cuánta cuantos cuántos este esta esto'.split(
    ' ',
  ),
);

/** OR-query over content words; only letters and digits reach to_tsquery. */
export function fullTextQuery(text: string): string {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (w) => w.length > 2 && !STOPWORDS.has(w),
  );
  return [...new Set(words)].slice(0, 32).join(' | ');
}

async function transition(
  db: Kysely<Database>,
  ctx: ActorContext,
  versionId: string,
  from: 'draft' | 'published',
  to: 'published' | 'retired',
): Promise<void> {
  assertRole(ctx, ['admin']);
  await withUnitOfWork(db, ctx, async (trx) => {
    const updated = await trx
      .updateTable('document_versions')
      .set(
        to === 'published'
          ? { status: to, published_at: new Date() }
          : { status: to, retired_at: new Date() },
      )
      .where('id', '=', versionId)
      .where('status', '=', from)
      .returning('id')
      .executeTakeFirst();
    if (!updated) {
      const exists = await trx
        .selectFrom('document_versions')
        .select('status')
        .where('id', '=', versionId)
        .executeTakeFirst();
      if (!exists) throw new DomainError('NOT_FOUND', 'Document version not found');
      throw new DomainError('CONFLICT', `Version is ${exists.status}, expected ${from}`);
    }
    await invalidateCache(trx);
    await appendAudit(trx, ctx, {
      action: to === 'published' ? 'knowledge.publish' : 'knowledge.retire',
      resourceType: 'document_version',
      resourceId: versionId,
      outcome: 'ALLOWED',
    });
  });
}

async function findByChecksum(
  trx: DomainTrx,
  sourceUri: string,
  checksum: string,
): Promise<IngestResult | undefined> {
  const row = await sql<{
    document_id: string;
    version_id: string;
    version: number;
    status: IngestResult['status'];
    chunks: number;
  }>`
    SELECT d.id AS document_id, v.id AS version_id, v.version, v.status,
           (SELECT COUNT(*)::int FROM commerce.chunks c
             WHERE c.tenant_id = v.tenant_id AND c.document_version_id = v.id) AS chunks
    FROM commerce.documents d
    JOIN commerce.document_versions v ON v.tenant_id = d.tenant_id AND v.document_id = d.id
    WHERE d.source_uri = ${sourceUri} AND v.checksum = ${checksum}
  `.execute(trx);
  const found = row.rows[0];
  if (!found) return undefined;
  return {
    documentId: found.document_id,
    versionId: found.version_id,
    version: found.version,
    checksum,
    status: found.status,
    chunks: found.chunks,
    duplicate: true,
  };
}

async function invalidateCache(trx: DomainTrx): Promise<void> {
  await trx.deleteFrom('retrieval_cache').execute();
}

async function corpusVersionOf(trx: DomainTrx, model: string): Promise<string> {
  const row = await sql<{ digest: string | null }>`
    SELECT md5(string_agg(id::text || ':' || status, ',' ORDER BY id)) AS digest
    FROM commerce.document_versions
  `.execute(trx);
  return `${model}:${row.rows[0]?.digest ?? 'empty'}`;
}

/** Expires at the TTL or at the next validity boundary, whichever comes first. */
async function cacheExpiry(trx: DomainTrx, at: Date | undefined): Promise<Date> {
  const now = new Date();
  const ttl = new Date(now.getTime() + RETRIEVAL_CACHE_TTL_MS);
  if (at !== undefined) return ttl;
  const row = await sql<{ next: Date | null }>`
    SELECT MIN(b) AS next FROM (
      SELECT valid_from AS b FROM commerce.document_versions
        WHERE status = 'published' AND valid_from > ${now}
      UNION ALL
      SELECT valid_to FROM commerce.document_versions
        WHERE status = 'published' AND valid_to > ${now}
    ) boundaries
  `.execute(trx);
  const next = row.rows[0]?.next;
  return next && next < ttl ? next : ttl;
}

function validateIngest(input: IngestInput): void {
  if (!DOCUMENT_KINDS.includes(input.kind)) {
    throw new DomainError('VALIDATION_ERROR', 'Unknown document kind', { field: 'kind' });
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\/\S{1,300}$/.test(input.sourceUri)) {
    throw new DomainError('VALIDATION_ERROR', 'sourceUri must be an absolute URI', {
      field: 'sourceUri',
    });
  }
  if (input.title.trim() === '' || input.body.trim() === '') {
    throw new DomainError('VALIDATION_ERROR', 'Title and body are required', { field: 'body' });
  }
  if (input.acl.length === 0 || input.acl.some((a) => a !== 'all' && !ROLES.includes(a))) {
    throw new DomainError('VALIDATION_ERROR', 'acl must list roles or "all"', { field: 'acl' });
  }
  if (input.validTo !== undefined && input.validTo <= input.validFrom) {
    throw new DomainError('VALIDATION_ERROR', 'validTo must be after validFrom', {
      field: 'validTo',
    });
  }
  if (input.kind === 'product' && input.productId === undefined) {
    throw new DomainError('VALIDATION_ERROR', 'Product documents need productId', {
      field: 'productId',
    });
  }
}

function validateQuery(query: string): string {
  const trimmed = query.trim();
  if (trimmed === '' || trimmed.length > MAX_QUERY_CHARS) {
    throw new DomainError('VALIDATION_ERROR', `query must have 1-${MAX_QUERY_CHARS} characters`, {
      field: 'query',
    });
  }
  return trimmed;
}

function assertEmbedder(embedder: Embedder): void {
  if (embedder.dimension !== EMBEDDING_DIM) {
    throw new DomainError(
      'DEPENDENCY_UNAVAILABLE',
      `Embedder ${embedder.model} has dimension ${String(embedder.dimension)}, schema expects ${String(EMBEDDING_DIM)}`,
    );
  }
}

function aclAllows(acl: unknown, role: Role): boolean {
  return Array.isArray(acl) && (acl.includes('all') || acl.includes(role));
}

function canonicalContent(input: IngestInput): string {
  return JSON.stringify({
    kind: input.kind,
    title: input.title,
    body: input.body,
    locale: input.locale,
    region: input.region,
    validFrom: input.validFrom.toISOString(),
    validTo: input.validTo?.toISOString() ?? null,
    productId: input.productId ?? null,
    acl: [...new Set(input.acl)].sort(),
  });
}

function withoutQuery(input: RecommendationQuery): Omit<RecommendationQuery, 'query'> {
  return Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'query')) as Omit<
    RecommendationQuery,
    'query'
  >;
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
