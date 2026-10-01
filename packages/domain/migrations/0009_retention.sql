-- M10: retention of the demo data model (docs/data-model.md): run state and run inputs 30 days,
-- audit and approval records 90 days. Logs (14 days) live outside PostgreSQL. Runs as the table
-- owner (`pnpm db:retention`); the runtime role cannot execute it.
CREATE OR REPLACE FUNCTION commerce.apply_retention(as_of timestamptz DEFAULT now())
RETURNS TABLE (entity text, affected bigint)
LANGUAGE plpgsql AS $$
DECLARE
  run_cutoff timestamptz := as_of - interval '30 days';
  audit_cutoff timestamptz := as_of - interval '90 days';
  n bigint;
BEGIN
  CREATE TEMP TABLE expired_runs ON COMMIT DROP AS
    SELECT tenant_id, id FROM commerce.agent_runs
    WHERE status IN ('COMPLETED', 'FAILED', 'CANCELLED') AND updated_at < run_cutoff;

  DELETE FROM commerce.graph_writes g USING expired_runs r
    WHERE g.tenant_id = r.tenant_id AND g.thread_id = r.id;
  GET DIAGNOSTICS n = ROW_COUNT; entity := 'graph_writes'; affected := n; RETURN NEXT;
  DELETE FROM commerce.graph_checkpoints g USING expired_runs r
    WHERE g.tenant_id = r.tenant_id AND g.thread_id = r.id;
  GET DIAGNOSTICS n = ROW_COUNT; entity := 'graph_checkpoints'; affected := n; RETURN NEXT;
  DELETE FROM commerce.checkpoints c USING expired_runs r
    WHERE c.tenant_id = r.tenant_id AND c.run_id = r.id;
  GET DIAGNOSTICS n = ROW_COUNT; entity := 'checkpoints'; affected := n; RETURN NEXT;
  DELETE FROM commerce.run_events e USING expired_runs r
    WHERE e.tenant_id = r.tenant_id AND e.run_id = r.id;
  GET DIAGNOSTICS n = ROW_COUNT; entity := 'run_events'; affected := n; RETURN NEXT;
  DELETE FROM commerce.evidence e USING expired_runs r
    WHERE e.tenant_id = r.tenant_id AND e.run_id = r.id;
  GET DIAGNOSTICS n = ROW_COUNT; entity := 'evidence'; affected := n; RETURN NEXT;
  -- The run row stays (approvals may reference it) but loses the user's free text.
  UPDATE commerce.agent_runs a SET input = '{}'::jsonb
    FROM expired_runs r WHERE a.tenant_id = r.tenant_id AND a.id = r.id AND a.input <> '{}'::jsonb;
  GET DIAGNOSTICS n = ROW_COUNT; entity := 'agent_runs.input'; affected := n; RETURN NEXT;

  DELETE FROM commerce.consents WHERE expires_at < run_cutoff;
  GET DIAGNOSTICS n = ROW_COUNT; entity := 'consents'; affected := n; RETURN NEXT;
  DELETE FROM commerce.idempotency_records WHERE created_at < run_cutoff;
  GET DIAGNOSTICS n = ROW_COUNT; entity := 'idempotency_records'; affected := n; RETURN NEXT;
  DELETE FROM commerce.retrieval_cache WHERE expires_at < as_of;
  GET DIAGNOSTICS n = ROW_COUNT; entity := 'retrieval_cache'; affected := n; RETURN NEXT;

  CREATE TEMP TABLE expired_requests ON COMMIT DROP AS
    SELECT tenant_id, id FROM commerce.action_requests
    WHERE status NOT IN ('PENDING', 'APPROVED') AND created_at < audit_cutoff;
  DELETE FROM commerce.approvals a USING expired_requests r
    WHERE a.tenant_id = r.tenant_id AND a.action_request_id = r.id;
  GET DIAGNOSTICS n = ROW_COUNT; entity := 'approvals'; affected := n; RETURN NEXT;
  DELETE FROM commerce.action_executions x USING expired_requests r
    WHERE x.tenant_id = r.tenant_id AND x.action_request_id = r.id;
  GET DIAGNOSTICS n = ROW_COUNT; entity := 'action_executions'; affected := n; RETURN NEXT;
  DELETE FROM commerce.action_requests x USING expired_requests r
    WHERE x.tenant_id = r.tenant_id AND x.id = r.id;
  GET DIAGNOSTICS n = ROW_COUNT; entity := 'action_requests'; affected := n; RETURN NEXT;
  DELETE FROM commerce.audit_events WHERE recorded_at < audit_cutoff;
  GET DIAGNOSTICS n = ROW_COUNT; entity := 'audit_events'; affected := n; RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION commerce.apply_retention(timestamptz) FROM PUBLIC;
