-- M4: knowledge corpus contract. No corpus was loaded before M4 (0001 created the tables empty
-- and nothing ingested into them), so derived rows are cleared instead of re-embedded.
DELETE FROM commerce.retrieval_cache;
DELETE FROM commerce.chunks;
DELETE FROM commerce.document_versions;
DELETE FROM commerce.documents;

ALTER TABLE commerce.chunks
  ALTER COLUMN embedding TYPE vector(384),
  ALTER COLUMN embedding SET NOT NULL,
  ADD COLUMN embedding_model text NOT NULL;

ALTER TABLE commerce.documents
  ADD CONSTRAINT documents_source_uri_key UNIQUE (tenant_id, source_uri),
  ADD COLUMN title text NOT NULL DEFAULT '';

ALTER TABLE commerce.document_versions
  ADD CONSTRAINT document_versions_checksum_key UNIQUE (tenant_id, document_id, checksum),
  ADD CONSTRAINT document_versions_validity CHECK (valid_to IS NULL OR valid_to > valid_from),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN published_at timestamptz,
  ADD COLUMN retired_at timestamptz;

CREATE INDEX document_versions_lookup_idx
  ON commerce.document_versions (tenant_id, status, region, locale, valid_from);
