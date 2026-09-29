import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { ActorContext } from './access.js';
import { EMBEDDING_MODEL } from './constants.js';
import type { Database } from './db.js';
import { DomainError } from './errors.js';
import { checksumOf, embedText, vectorLiteral } from './embed.js';
import { appendAudit, withUnitOfWork } from './uow.js';

export interface IngestInput {
  readonly sourceUri: string;
  readonly kind: 'policy' | 'faq' | 'shipping' | 'returns' | 'product';
  readonly body: string;
  readonly section: string;
  readonly locale: string;
  readonly region: string;
  readonly validFrom: Date;
  readonly validTo?: Date;
  readonly productId?: string;
  readonly acl: readonly string[];
}

export interface IngestResult {
  readonly documentId: string;
  readonly versionId: string;
  readonly version: number;
  readonly checksum: string;
  readonly duplicate: boolean;
}

export interface Citation {
  readonly documentVersionId: string;
  readonly section: string;
  readonly sourceUri: string;
  readonly version: number;
  readonly excerpt: string;
}

export interface RetrievalHit {
  readonly chunkId: string;
  readonly score: number;
  readonly citation: Citation;
  readonly body: string;
}

export async function ingestDocument(
  db: Kysely<Database>,
  ctx: ActorContext,
  input: IngestInput,
): Promise<IngestResult> {
  const checksum = checksumOf(input.body);
  return withUnitOfWork(db, ctx, async (trx) => {
    let document = await trx
      .selectFrom('documents')
      .selectAll()
      .where('source_uri', '=', input.sourceUri)
      .executeTakeFirst();
    if (!document) {
      const id = randomUUID();
      await trx
        .insertInto('documents')
        .values({
          tenant_id: ctx.tenantId,
          id,
          kind: input.kind,
          source_uri: input.sourceUri,
          product_id: input.productId ?? null,
        })
        .execute();
      document = await trx
        .selectFrom('documents')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
    }
    const latest = await trx
      .selectFrom('document_versions')
      .selectAll()
      .where('document_id', '=', document.id)
      .orderBy('version', 'desc')
      .executeTakeFirst();
    if (latest?.checksum === checksum) {
      return {
        documentId: document.id,
        versionId: latest.id,
        version: latest.version,
        checksum,
        duplicate: true,
      };
    }
    const version = (latest?.version ?? 0) + 1;
    const versionId = randomUUID();
    await trx
      .insertInto('document_versions')
      .values({
        tenant_id: ctx.tenantId,
        id: versionId,
        document_id: document.id,
        checksum,
        version,
        status: 'published',
        locale: input.locale,
        region: input.region,
        valid_from: input.validFrom,
        valid_to: input.validTo ?? null,
        acl: JSON.stringify(input.acl),
      })
      .execute();
    const chunks = chunkBody(input.body, input.section);
    for (const [ordinal, chunk] of chunks.entries()) {
      const embedding = vectorLiteral(embedText(chunk));
      await sql`
        INSERT INTO commerce.chunks
          (tenant_id, id, document_version_id, ordinal, body, section, token_count, embedding)
        VALUES (
          ${ctx.tenantId}::uuid, ${randomUUID()}::uuid, ${versionId}::uuid, ${ordinal},
          ${chunk}, ${input.section}, ${Math.max(1, Math.ceil(chunk.length / 4))},
          ${embedding}::vector
        )
      `.execute(trx);
    }
    await trx.deleteFrom('retrieval_cache').where('tenant_id', '=', ctx.tenantId).execute();
    await appendAudit(trx, ctx, {
      action: 'knowledge.ingest',
      resourceType: 'document',
      resourceId: document.id,
      outcome: 'ALLOWED',
    });
    return { documentId: document.id, versionId, version, checksum, duplicate: false };
  });
}

export async function retireDocumentVersion(
  db: Kysely<Database>,
  ctx: ActorContext,
  versionId: string,
): Promise<void> {
  await withUnitOfWork(db, ctx, async (trx) => {
    const updated = await sql<{ n: number }>`
      UPDATE commerce.document_versions
      SET status = 'retired'
      WHERE id = ${versionId}::uuid
      RETURNING 1 AS n
    `.execute(trx);
    if ((updated.rows[0]?.n ?? 0) === 0) throw new DomainError('NOT_FOUND', 'Version not found');
    await trx.deleteFrom('retrieval_cache').where('tenant_id', '=', ctx.tenantId).execute();
    await appendAudit(trx, ctx, {
      action: 'knowledge.retire',
      resourceType: 'document_version',
      resourceId: versionId,
      outcome: 'ALLOWED',
    });
  });
}

export async function retrieve(
  db: Kysely<Database>,
  ctx: ActorContext,
  input: {
    query: string;
    kind?: IngestInput['kind'];
    region?: string;
    locale?: string;
    at?: Date;
    productId?: string;
  },
): Promise<readonly RetrievalHit[]> {
  const queryVector = vectorLiteral(embedText(input.query));
  const at = input.at ?? new Date();
  return withUnitOfWork(db, ctx, async (trx) => {
    const rows = await sql<{
      chunkId: string;
      body: string;
      section: string;
      versionId: string;
      version: number;
      sourceUri: string;
      vectorDistance: number;
      ftsRank: number;
    }>`
      SELECT c.id AS "chunkId",
             c.body AS body,
             c.section AS section,
             v.id AS "versionId",
             v.version AS version,
             d.source_uri AS "sourceUri",
             (c.embedding <=> ${queryVector}::vector) AS "vectorDistance",
             ts_rank(c.tsv, plainto_tsquery('simple', ${input.query})) AS "ftsRank"
      FROM commerce.chunks c
      JOIN commerce.document_versions v
        ON v.tenant_id = c.tenant_id AND v.id = c.document_version_id
      JOIN commerce.documents d
        ON d.tenant_id = c.tenant_id AND d.id = v.document_id
      WHERE v.status = 'published'
        AND v.valid_from <= ${at}
        AND (v.valid_to IS NULL OR v.valid_to > ${at})
        AND (v.acl ? ${ctx.role} OR v.acl ? ${'all'})
        AND (${input.kind ?? null}::text IS NULL OR d.kind = ${input.kind ?? null})
        AND (${input.region ?? null}::text IS NULL OR v.region = ${input.region ?? null})
        AND (${input.locale ?? null}::text IS NULL OR v.locale = ${input.locale ?? null})
        AND (${input.productId ?? null}::uuid IS NULL OR d.product_id = ${input.productId ?? null}::uuid)
      LIMIT 30
    `.execute(trx);
    const byVector = [...rows.rows].sort((a, b) => a.vectorDistance - b.vectorDistance);
    const byFts = [...rows.rows].sort((a, b) => b.ftsRank - a.ftsRank);
    const scores = new Map<string, { row: (typeof rows.rows)[number]; score: number }>();
    const k = 60;
    byVector.forEach((row, i) => {
      scores.set(row.chunkId, { row, score: 1 / (k + i + 1) });
    });
    byFts.forEach((row, i) => {
      const current = scores.get(row.chunkId);
      const add = 1 / (k + i + 1);
      if (current) current.score += add;
      else scores.set(row.chunkId, { row, score: add });
    });
    const fused = [...scores.values()].sort((a, b) => b.score - a.score).slice(0, 6);
    await appendAudit(trx, ctx, {
      action: 'knowledge.retrieve',
      resourceType: 'chunk',
      outcome: 'ALLOWED',
    });
    return fused.map(({ row, score }) => ({
      chunkId: row.chunkId,
      score,
      body: row.body,
      citation: {
        documentVersionId: row.versionId,
        section: row.section,
        sourceUri: row.sourceUri,
        version: row.version,
        excerpt: row.body.slice(0, 240),
      },
    }));
  });
}

export async function selectPolicyForOrder(
  db: Kysely<Database>,
  ctx: ActorContext,
  input: { kind: 'shipping' | 'returns'; purchasedAt: Date; region: string },
): Promise<RetrievalHit | undefined> {
  const hits = await retrieve(db, ctx, {
    query: input.kind,
    kind: input.kind,
    region: input.region,
    at: input.purchasedAt,
  });
  if (hits.length === 0) return undefined;
  const bodies = new Set(hits.map((h) => h.body));
  if (bodies.size > 1) {
    throw new DomainError('CONFLICT', 'Authorized policy sources contradict each other', {
      abstain: true,
    });
  }
  return hits[0];
}

export function embeddingModel(): string {
  return EMBEDDING_MODEL;
}

function chunkBody(body: string, section: string): string[] {
  const size = 1600;
  if (body.length <= size) return [`${section}\n${body}`];
  const parts: string[] = [];
  for (let i = 0; i < body.length; i += size - 200) {
    parts.push(`${section}\n${body.slice(i, i + size)}`);
  }
  return parts;
}
