-- M4: local hash embedder dimension is 32 (decision recorded in add-hybrid-retrieval/design.md).
ALTER TABLE commerce.chunks
  ADD COLUMN embedding vector(32);

ALTER TABLE commerce.chunks
  ADD COLUMN tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', body)) STORED;

CREATE INDEX chunks_tsv_idx ON commerce.chunks USING gin (tsv);

CREATE TABLE commerce.retrieval_cache (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  cache_key text NOT NULL,
  payload jsonb NOT NULL,
  corpus_version text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, cache_key)
);

ALTER TABLE commerce.retrieval_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON commerce.retrieval_cache
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON commerce.retrieval_cache TO commerce_runtime;
