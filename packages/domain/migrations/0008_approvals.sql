-- M8: bound human approval (add-human-approval design.md).
-- One effective decision per action request, bound to the exact canonical payload it approved.
ALTER TABLE commerce.approvals
  ADD COLUMN canonical_args_hash text,
  ADD CONSTRAINT approvals_one_decision UNIQUE (tenant_id, action_request_id);

UPDATE commerce.approvals a
SET canonical_args_hash = r.canonical_args_hash
FROM commerce.action_requests r
WHERE r.tenant_id = a.tenant_id AND r.id = a.action_request_id;

ALTER TABLE commerce.approvals ALTER COLUMN canonical_args_hash SET NOT NULL;

ALTER TABLE commerce.action_requests
  ADD COLUMN decided_at timestamptz,
  ADD CONSTRAINT action_requests_hash CHECK (canonical_args_hash ~ '^[0-9a-f]{64}$');

-- Decisions and executions are append-only facts for the runtime.
REVOKE UPDATE, DELETE ON commerce.approvals, commerce.action_executions FROM commerce_runtime;
REVOKE DELETE ON commerce.action_requests FROM commerce_runtime;
