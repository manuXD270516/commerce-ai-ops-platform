import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { ActorContext, Role } from './access.js';
import { POLICY_VERSION } from './constants.js';
import type { Database } from './db.js';
import { DomainError } from './errors.js';
import { appendAudit, withUnitOfWork, type DomainTrx } from './uow.js';

/** Per-run limits (docs/agents-security-mcp.md). Human wait never counts as active time. */
export const DEFAULT_BUDGETS = {
  llmCalls: 6,
  toolCalls: 12,
  tokens: 12_000,
  activeMs: 60_000,
} as const;
export type RunBudgets = { readonly [K in keyof typeof DEFAULT_BUDGETS]: number };

export interface RunUsage {
  readonly llmCalls: number;
  readonly toolCalls: number;
  readonly tokens: number;
  readonly activeMs: number;
}

export const EMPTY_USAGE: RunUsage = { llmCalls: 0, toolCalls: 0, tokens: 0, activeMs: 0 };

export const RUN_STATUSES = [
  'QUEUED',
  'RUNNING',
  'WAITING_HUMAN',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export type RunOutcome =
  | 'ANSWERED'
  | 'CLARIFICATION_REQUESTED'
  | 'REFUSED'
  | 'BUDGET_EXCEEDED'
  | 'ACCESS_REVOKED'
  | 'CANCELLED'
  | 'ACTION_EXECUTED'
  | 'ACTION_REJECTED'
  | 'ACTION_FAILED'
  | 'ERROR';

export interface RunInput {
  readonly message: string;
  readonly uiContext?: { readonly intent: string; readonly orderId?: string };
}

export interface AgentRunRecord {
  readonly id: string;
  readonly subjectId: string;
  readonly status: RunStatus;
  readonly outcome: RunOutcome | null;
  readonly intent: string | null;
  readonly budgets: RunBudgets;
  readonly usage: RunUsage;
  readonly promptVersion: string | null;
  readonly modelVersion: string | null;
  readonly routerVersion: string | null;
  readonly cancelRequested: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RunEvent {
  readonly seq: number;
  readonly data: unknown;
  readonly recordedAt: string;
}

/** Staff roles that may follow any run of their tenant; everyone else only sees their own runs. */
const RUN_READERS: readonly Role[] = ['support', 'approver'];
const MAX_MESSAGE_CHARS = 2000;

export async function createAgentRun(
  db: Kysely<Database>,
  ctx: ActorContext,
  input: RunInput & {
    promptVersion: string;
    modelVersion: string;
    routerVersion: string;
    budgets?: RunBudgets;
  },
): Promise<AgentRunRecord> {
  const message = input.message.trim();
  if (message.length === 0 || message.length > MAX_MESSAGE_CHARS) {
    throw new DomainError(
      'VALIDATION_ERROR',
      `message must have 1-${MAX_MESSAGE_CHARS} characters`,
      {
        field: 'message',
      },
    );
  }
  return withUnitOfWork(db, ctx, async (trx) => {
    const id = randomUUID();
    await trx
      .insertInto('agent_runs')
      .values({
        tenant_id: ctx.tenantId,
        id,
        subject_id: ctx.subjectId,
        customer_id: ctx.customerId ?? null,
        intent: null,
        status: 'QUEUED',
        budgets: JSON.stringify(input.budgets ?? DEFAULT_BUDGETS),
        prompt_version: input.promptVersion,
        model_version: input.modelVersion,
        router_version: input.routerVersion,
        input: JSON.stringify({
          message,
          ...(input.uiContext ? { uiContext: input.uiContext } : {}),
        }),
        usage: JSON.stringify(EMPTY_USAGE),
      })
      .execute();
    await insertEvent(trx, ctx, id, { type: 'status', status: 'QUEUED' });
    await appendAudit(trx, ctx, {
      action: 'runs.create',
      resourceType: 'agent_run',
      resourceId: id,
      outcome: 'ALLOWED',
    });
    return readRun(trx, id);
  });
}

export async function getAgentRun(
  db: Kysely<Database>,
  ctx: ActorContext,
  runId: string,
): Promise<AgentRunRecord> {
  return withUnitOfWork(db, ctx, async (trx) => {
    await assertCanRead(trx, ctx, runId);
    return readRun(trx, runId);
  });
}

/** Events after `afterSeq` (exclusive), for SSE replay after a reconnection. */
export async function listRunEvents(
  db: Kysely<Database>,
  ctx: ActorContext,
  runId: string,
  afterSeq = -1,
): Promise<readonly RunEvent[]> {
  return withUnitOfWork(db, ctx, async (trx) => {
    await assertCanRead(trx, ctx, runId);
    const rows = await trx
      .selectFrom('run_events')
      .selectAll()
      .where('run_id', '=', runId)
      .where('seq', '>', afterSeq)
      .orderBy('seq', 'asc')
      .limit(500)
      .execute();
    return rows.map((e) => ({ seq: e.seq, data: e.data, recordedAt: e.recorded_at.toISOString() }));
  });
}

export async function appendRunEvent(
  db: Kysely<Database>,
  ctx: ActorContext,
  runId: string,
  data: Record<string, unknown>,
): Promise<number> {
  return withUnitOfWork(db, ctx, (trx) => insertEvent(trx, ctx, runId, data));
}

async function insertEvent(
  trx: DomainTrx,
  ctx: ActorContext,
  runId: string,
  data: Record<string, unknown>,
): Promise<number> {
  // Serialize appends per run so seq stays gapless under concurrent writers.
  await sql`SELECT 1 FROM commerce.agent_runs WHERE id = ${runId}::uuid FOR UPDATE`.execute(trx);
  const last = await trx
    .selectFrom('run_events')
    .select('seq')
    .where('run_id', '=', runId)
    .orderBy('seq', 'desc')
    .executeTakeFirst();
  const seq = (last?.seq ?? -1) + 1;
  await trx
    .insertInto('run_events')
    .values({ tenant_id: ctx.tenantId, id: randomUUID(), run_id: runId, seq, data })
    .execute();
  return seq;
}

export interface RunUpdate {
  readonly status?: RunStatus;
  readonly outcome?: RunOutcome | null;
  readonly intent?: string | null;
  readonly usage?: RunUsage;
  readonly event?: Record<string, unknown>;
}

/** Persists run progress and, optionally, a client-visible event in the same transaction. */
export async function updateAgentRun(
  db: Kysely<Database>,
  ctx: ActorContext,
  runId: string,
  update: RunUpdate,
): Promise<void> {
  await withUnitOfWork(db, ctx, async (trx) => {
    await trx
      .updateTable('agent_runs')
      .set({
        ...(update.status ? { status: update.status } : {}),
        ...(update.outcome !== undefined ? { outcome: update.outcome } : {}),
        ...(update.intent !== undefined ? { intent: update.intent } : {}),
        ...(update.usage ? { usage: JSON.stringify(update.usage) } : {}),
        ...(update.status && update.status !== 'RUNNING'
          ? { lease_owner: null, lease_expires_at: null }
          : {}),
        updated_at: new Date(),
      })
      .where('id', '=', runId)
      .execute();
    if (update.event) await insertEvent(trx, ctx, runId, update.event);
  });
}

/**
 * Cancels a run for its owner or support. Queued or waiting runs stop at once; a running run sees
 * the request before its next tool or model call. An effect already committed is reported, never
 * reverted.
 */
export async function requestRunCancellation(
  db: Kysely<Database>,
  ctx: ActorContext,
  runId: string,
): Promise<AgentRunRecord> {
  return withUnitOfWork(db, ctx, async (trx) => {
    const run = await trx
      .selectFrom('agent_runs')
      .select(['subject_id', 'status'])
      .where('id', '=', runId)
      .forUpdate()
      .executeTakeFirst();
    if (!run || (run.subject_id !== ctx.subjectId && ctx.role !== 'support')) {
      throw new DomainError('NOT_FOUND', 'Run not found');
    }
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status)) {
      throw new DomainError('CONFLICT', `Run is already ${run.status}`);
    }
    const immediate = run.status !== 'RUNNING';
    await trx
      .updateTable('agent_runs')
      .set({
        cancel_requested_at: new Date(),
        ...(immediate ? { status: 'CANCELLED', outcome: 'CANCELLED' } : {}),
        updated_at: new Date(),
      })
      .where('id', '=', runId)
      .execute();
    await insertEvent(trx, ctx, runId, {
      type: 'status',
      status: immediate ? 'CANCELLED' : 'CANCELLING',
    });
    await appendAudit(trx, ctx, {
      action: 'runs.cancel',
      resourceType: 'agent_run',
      resourceId: runId,
      outcome: 'ALLOWED',
    });
    return readRun(trx, runId);
  });
}

export interface ClaimedRun {
  readonly id: string;
  readonly tenantId: string;
  readonly subjectId: string;
  readonly status: RunStatus;
  readonly input: RunInput;
  readonly budgets: RunBudgets;
  readonly usage: RunUsage;
}

/**
 * Takes a time-bounded lease on a run so only one worker drives it. Expired leases (a crashed
 * worker) can be taken over. Runs the executor's service identity; the run owner's membership is
 * re-resolved separately before any tool call.
 */
export async function claimAgentRun(
  db: Kysely<Database>,
  tenantId: string,
  runId: string,
  workerId: string,
  leaseMs: number,
): Promise<ClaimedRun | undefined> {
  return withUnitOfWork(db, executorActor(tenantId), async (trx) => {
    const claimed = await sql<{
      id: string;
      subject_id: string;
      status: RunStatus;
      input: RunInput;
      budgets: RunBudgets;
      usage: RunUsage;
    }>`
      UPDATE commerce.agent_runs
      SET status = CASE WHEN status = 'QUEUED' THEN 'RUNNING' ELSE status END,
          lease_owner = ${workerId},
          lease_expires_at = now() + make_interval(secs => ${leaseMs / 1000}),
          updated_at = now()
      WHERE id = ${runId}::uuid
        AND status IN ('QUEUED', 'RUNNING', 'WAITING_HUMAN')
        AND cancel_requested_at IS NULL
        AND (lease_expires_at IS NULL OR lease_expires_at < now() OR lease_owner = ${workerId})
      RETURNING id, subject_id, status, input, budgets, usage
    `.execute(trx);
    const row = claimed.rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      tenantId,
      subjectId: row.subject_id,
      status: row.status,
      input: row.input,
      budgets: row.budgets,
      usage: { ...EMPTY_USAGE, ...row.usage },
    };
  });
}

export async function releaseAgentRun(
  db: Kysely<Database>,
  tenantId: string,
  runId: string,
  workerId: string,
): Promise<void> {
  await withUnitOfWork(db, executorActor(tenantId), async (trx) => {
    await trx
      .updateTable('agent_runs')
      .set({ lease_owner: null, lease_expires_at: null })
      .where('id', '=', runId)
      .where('lease_owner', '=', workerId)
      .execute();
  });
}

export async function isRunCancelled(
  db: Kysely<Database>,
  ctx: ActorContext,
  runId: string,
): Promise<boolean> {
  return withUnitOfWork(db, ctx, async (trx) => {
    const row = await trx
      .selectFrom('agent_runs')
      .select(['cancel_requested_at', 'status'])
      .where('id', '=', runId)
      .executeTakeFirst();
    return row?.cancel_requested_at !== null || row.status === 'CANCELLED';
  });
}

/** Runs a worker should (re)drive: queued, or running with an expired lease (crashed worker). */
export async function listRecoverableRuns(
  db: Kysely<Database>,
  tenantId: string,
): Promise<readonly string[]> {
  return withUnitOfWork(db, executorActor(tenantId), async (trx) => {
    const rows = await trx
      .selectFrom('agent_runs')
      .select('id')
      .where('cancel_requested_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb('status', '=', 'QUEUED'),
          eb.and([
            eb('status', '=', 'RUNNING'),
            eb.or([eb('lease_expires_at', 'is', null), eb('lease_expires_at', '<', new Date())]),
          ]),
          // Waiting runs whose human decision exists (or whose request expired) can resume.
          eb.and([
            eb('status', '=', 'WAITING_HUMAN'),
            sql<boolean>`EXISTS (
              SELECT 1 FROM commerce.action_requests ar
              WHERE ar.run_id = agent_runs.id
                AND (ar.status <> 'PENDING' OR ar.expires_at < now()))`,
          ]),
        ]),
      )
      .orderBy('created_at', 'asc')
      .limit(100)
      .execute();
    return rows.map((r) => r.id);
  });
}

export interface EvidenceInput {
  readonly kind: string;
  readonly resourceRef: string;
  readonly version: string;
  readonly observedAt: string;
  readonly documentVersionId?: string;
}

export async function recordEvidence(
  db: Kysely<Database>,
  ctx: ActorContext,
  runId: string,
  items: readonly EvidenceInput[],
): Promise<void> {
  if (items.length === 0) return;
  await withUnitOfWork(db, ctx, async (trx) => {
    await trx
      .insertInto('evidence')
      .values(
        items.map((e) => ({
          tenant_id: ctx.tenantId,
          id: randomUUID(),
          run_id: runId,
          kind: e.kind,
          resource_ref: e.resourceRef,
          version: e.version,
          observed_at: new Date(e.observedAt),
          document_version_id: e.documentVersionId ?? null,
        })),
      )
      .execute();
  });
}

export async function listRunEvidence(
  db: Kysely<Database>,
  ctx: ActorContext,
  runId: string,
): Promise<readonly EvidenceInput[]> {
  return withUnitOfWork(db, ctx, async (trx) => {
    await assertCanRead(trx, ctx, runId);
    const rows = await trx
      .selectFrom('evidence')
      .selectAll()
      .where('run_id', '=', runId)
      .orderBy('observed_at', 'asc')
      .execute();
    return rows.map((r) => ({
      kind: r.kind,
      resourceRef: r.resource_ref,
      version: r.version,
      observedAt: r.observed_at.toISOString(),
      ...(r.document_version_id ? { documentVersionId: r.document_version_id } : {}),
    }));
  });
}

/** Identity of the run executor: reads and leases runs, never calls tools on its own behalf. */
export function executorActor(tenantId: string): ActorContext {
  return {
    tenantId,
    subjectId: 'service:agent-executor',
    role: 'support',
    policyVersion: POLICY_VERSION,
  };
}

async function assertCanRead(trx: DomainTrx, ctx: ActorContext, runId: string): Promise<void> {
  const run = await trx
    .selectFrom('agent_runs')
    .select('subject_id')
    .where('id', '=', runId)
    .executeTakeFirst();
  if (!run || (run.subject_id !== ctx.subjectId && !RUN_READERS.includes(ctx.role))) {
    await appendAudit(trx, ctx, {
      action: 'runs.read',
      resourceType: 'agent_run',
      resourceId: runId,
      outcome: 'DENIED',
    });
    throw new DomainError('NOT_FOUND', 'Run not found');
  }
}

async function readRun(trx: DomainTrx, runId: string): Promise<AgentRunRecord> {
  const run = await trx
    .selectFrom('agent_runs')
    .selectAll()
    .where('id', '=', runId)
    .executeTakeFirstOrThrow();
  return {
    id: run.id,
    subjectId: run.subject_id,
    status: run.status as RunStatus,
    outcome: run.outcome as RunOutcome | null,
    intent: run.intent,
    budgets: run.budgets as RunBudgets,
    usage: { ...EMPTY_USAGE, ...(run.usage as Partial<RunUsage>) },
    promptVersion: run.prompt_version,
    modelVersion: run.model_version,
    routerVersion: run.router_version,
    cancelRequested: run.cancel_requested_at !== null,
    createdAt: run.created_at.toISOString(),
    updatedAt: run.updated_at.toISOString(),
  };
}
