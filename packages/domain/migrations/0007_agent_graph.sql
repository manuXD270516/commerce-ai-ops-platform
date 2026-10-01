-- M6: durable agent runs (add-agent-router design.md). Graph checkpoints live in PostgreSQL under
-- the same tenant RLS as every business table; Redis only carries job notifications.
ALTER TABLE commerce.agent_runs
  ADD COLUMN input jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN outcome text,
  ADD COLUMN usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN router_version text,
  ADD COLUMN cancel_requested_at timestamptz,
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT agent_runs_outcome CHECK (
    outcome IS NULL OR outcome IN (
      'ANSWERED', 'CLARIFICATION_REQUESTED', 'REFUSED', 'BUDGET_EXCEEDED', 'ACCESS_REVOKED',
      'CANCELLED', 'ACTION_EXECUTED', 'ACTION_REJECTED', 'ACTION_FAILED', 'ERROR'
    )
  );

CREATE INDEX agent_runs_resumable_idx
  ON commerce.agent_runs (tenant_id, status, lease_expires_at)
  WHERE status IN ('QUEUED', 'RUNNING', 'WAITING_HUMAN');

CREATE TABLE commerce.graph_checkpoints (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  thread_id uuid NOT NULL,
  checkpoint_ns text NOT NULL DEFAULT '',
  checkpoint_id text NOT NULL,
  parent_checkpoint_id text,
  checkpoint bytea NOT NULL,
  metadata bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, thread_id, checkpoint_ns, checkpoint_id),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES commerce.agent_runs (tenant_id, id)
);

CREATE TABLE commerce.graph_writes (
  tenant_id uuid NOT NULL REFERENCES commerce.tenants (id),
  thread_id uuid NOT NULL,
  checkpoint_ns text NOT NULL DEFAULT '',
  checkpoint_id text NOT NULL,
  write_key text NOT NULL,
  task_id text NOT NULL,
  channel text NOT NULL,
  value bytea NOT NULL,
  PRIMARY KEY (tenant_id, thread_id, checkpoint_ns, checkpoint_id, write_key),
  FOREIGN KEY (tenant_id, thread_id) REFERENCES commerce.agent_runs (tenant_id, id)
);

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['graph_checkpoints', 'graph_writes'] LOOP
    EXECUTE format('ALTER TABLE commerce.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON commerce.%I
         USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      tbl
    );
  END LOOP;
END $$;

-- Checkpoints are append-only history. Pending writes of LangGraph's special channels (error,
-- interrupt, resume) are replaced in place, so graph_writes also allows UPDATE; nothing is deleted.
GRANT SELECT, INSERT ON commerce.graph_checkpoints TO commerce_runtime;
GRANT SELECT, INSERT, UPDATE ON commerce.graph_writes TO commerce_runtime;
REVOKE UPDATE, DELETE ON commerce.graph_checkpoints FROM commerce_runtime;
REVOKE DELETE ON commerce.graph_writes FROM commerce_runtime;
