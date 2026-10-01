-- M5: explicit, verifiable consent for WRITE tools (add-controlled-mcp design.md).
-- A consent is recorded by an authenticated UI event of the subject, bound to the command and the
-- canonical payload hash, short-lived and consumed at most once. Model text never creates one.
CREATE TABLE commerce.consents (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  subject_id text NOT NULL,
  command text NOT NULL CHECK (command IN ('create_support_ticket')),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  CHECK (expires_at > created_at),
  FOREIGN KEY (tenant_id, run_id) REFERENCES commerce.agent_runs (tenant_id, id)
);

ALTER TABLE commerce.consents ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON commerce.consents
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
-- Only the subject who gave a consent can see or consume it.
CREATE POLICY consent_owner ON commerce.consents
  AS RESTRICTIVE
  USING (subject_id = current_setting('app.subject_id', true))
  WITH CHECK (subject_id = current_setting('app.subject_id', true));
GRANT SELECT, INSERT, UPDATE ON commerce.consents TO commerce_runtime;
REVOKE DELETE ON commerce.consents FROM commerce_runtime;

CREATE INDEX tickets_subject_created_idx ON commerce.tickets (tenant_id, created_by, created_at);
