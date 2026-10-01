import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Kysely } from 'kysely';
import type { ActorContext } from './access.js';
import { POLICY_VERSION } from './constants.js';
import type { Database } from './db.js';
import type { Embedder } from './embed.js';
import { FIXTURES } from './fixture-ids.js';
import {
  ingestDocument,
  type AclEntry,
  type DocumentKind,
  type IngestResult,
} from './knowledge.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
export const KNOWLEDGE_FIXTURE_DIR = join(repoRoot, 'evals/fixtures/knowledge/0.1.0');

/** Explicit service identity of the ingestion pipeline; it only holds the admin ingest role. */
export const KNOWLEDGE_INGEST_SUBJECT = 'service:knowledge-ingest';

export interface CorpusDocument {
  readonly id: string;
  readonly tenant: keyof typeof FIXTURES.tenants;
  readonly sourceUri: string;
  readonly kind: DocumentKind;
  readonly title: string;
  readonly body: string;
  readonly locale: string;
  readonly region: string;
  readonly validFrom: string;
  readonly validTo?: string;
  readonly productId?: string;
  readonly acl: readonly AclEntry[];
}

export async function loadCorpus(dir = KNOWLEDGE_FIXTURE_DIR): Promise<CorpusDocument[]> {
  const text = await readFile(join(dir, 'corpus.jsonl'), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const row = JSON.parse(line) as { id: string; input: Omit<CorpusDocument, 'id'> };
      return { id: row.id, ...row.input };
    });
}

export function ingestActor(tenantId: string): ActorContext {
  return {
    tenantId,
    subjectId: KNOWLEDGE_INGEST_SUBJECT,
    role: 'admin',
    policyVersion: POLICY_VERSION,
  };
}

/**
 * Ingests and publishes the versioned fixture corpus. Repeating it is a no-op per checksum, so
 * `pnpm db:seed` can run any number of times.
 */
export async function seedKnowledgeCorpus(
  db: Kysely<Database>,
  embedder: Embedder,
  dir = KNOWLEDGE_FIXTURE_DIR,
): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  for (const doc of await loadCorpus(dir)) {
    results.push(
      await ingestDocument(db, ingestActor(FIXTURES.tenants[doc.tenant]), embedder, {
        sourceUri: doc.sourceUri,
        kind: doc.kind,
        title: doc.title,
        body: doc.body,
        locale: doc.locale,
        region: doc.region,
        validFrom: new Date(doc.validFrom),
        ...(doc.validTo ? { validTo: new Date(doc.validTo) } : {}),
        ...(doc.productId ? { productId: doc.productId } : {}),
        acl: doc.acl,
        publish: true,
      }),
    );
  }
  return results;
}
