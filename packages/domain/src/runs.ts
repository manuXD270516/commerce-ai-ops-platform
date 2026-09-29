import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { ActorContext } from './access.js';
import type { Database } from './db.js';
import { DomainError } from './errors.js';
import { appendAudit, withUnitOfWork } from './uow.js';

export const DEFAULT_BUDGETS = {
  llmCalls: 6,
  toolCalls: 12,
  tokens: 12_000,
  activeMs: 60_000,
} as const;

export interface AgentRunRecord {
  readonly id: string;
  readonly status: string;
  readonly intent: string | null;
  readonly budgets: typeof DEFAULT_BUDGETS;
  readonly promptVersion: string | null;
  readonly modelVersion: string | null;
}

export interface RunEvent {
  readonly seq: number;
  readonly data: unknown;
  readonly recordedAt: string;
}

export async function createAgentRun(
  db: Kysely<Database>,
  ctx: ActorContext,
  input: { intent?: string; promptVersion: string; modelVersion: string },
): Promise<AgentRunRecord> {
  return withUnitOfWork(db, ctx, async (trx) => {
    const id = randomUUID();
    await trx
      .insertInto('agent_runs')
      .values({
        tenant_id: ctx.tenantId,
        id,
        subject_id: ctx.subjectId,
        customer_id: ctx.customerId ?? null,
        intent: input.intent ?? null,
        status: 'QUEUED',
        budgets: DEFAULT_BUDGETS,
        prompt_version: input.promptVersion,
        model_version: input.modelVersion,
      })
      .execute();
    await trx
      .insertInto('run_events')
      .values({
        tenant_id: ctx.tenantId,
        id: randomUUID(),
        run_id: id,
        seq: 0,
        data: { type: 'created', intent: input.intent ?? null },
      })
      .execute();
    await appendAudit(trx, ctx, {
      action: 'runs.create',
      resourceType: 'agent_run',
      resourceId: id,
      outcome: 'ALLOWED',
    });
    return {
      id,
      status: 'QUEUED',
      intent: input.intent ?? null,
      budgets: DEFAULT_BUDGETS,
      promptVersion: input.promptVersion,
      modelVersion: input.modelVersion,
    };
  });
}

export async function getAgentRun(
  db: Kysely<Database>,
  ctx: ActorContext,
  runId: string,
): Promise<AgentRunRecord & { events: readonly RunEvent[] }> {
  return withUnitOfWork(db, ctx, async (trx) => {
    const run = await trx
      .selectFrom('agent_runs')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirst();
    if (!run) throw new DomainError('NOT_FOUND', 'Run not found');
    const events = await trx
      .selectFrom('run_events')
      .selectAll()
      .where('run_id', '=', runId)
      .orderBy('seq', 'asc')
      .execute();
    return {
      id: run.id,
      status: run.status,
      intent: run.intent,
      budgets: DEFAULT_BUDGETS,
      promptVersion: run.prompt_version,
      modelVersion: run.model_version,
      events: events.map((e) => ({
        seq: e.seq,
        data: e.data,
        recordedAt: e.recorded_at.toISOString(),
      })),
    };
  });
}

export async function saveCheckpoint(
  db: Kysely<Database>,
  ctx: ActorContext,
  runId: string,
  payload: unknown,
  status: string,
): Promise<void> {
  await withUnitOfWork(db, ctx, async (trx) => {
    await trx
      .insertInto('checkpoints')
      .values({
        tenant_id: ctx.tenantId,
        id: randomUUID(),
        run_id: runId,
        payload,
      })
      .execute();
    await trx.updateTable('agent_runs').set({ status }).where('id', '=', runId).execute();
  });
}

export async function latestCheckpoint(
  db: Kysely<Database>,
  ctx: ActorContext,
  runId: string,
): Promise<unknown> {
  return withUnitOfWork(db, ctx, async (trx) => {
    const row = await trx
      .selectFrom('checkpoints')
      .select('payload')
      .where('run_id', '=', runId)
      .orderBy('recorded_at', 'desc')
      .executeTakeFirst();
    return row?.payload;
  });
}

export async function appendRunEvent(
  db: Kysely<Database>,
  ctx: ActorContext,
  runId: string,
  data: unknown,
): Promise<number> {
  return withUnitOfWork(db, ctx, async (trx) => {
    const last = await trx
      .selectFrom('run_events')
      .select('seq')
      .where('run_id', '=', runId)
      .orderBy('seq', 'desc')
      .executeTakeFirst();
    const seq = (last?.seq ?? -1) + 1;
    await trx
      .insertInto('run_events')
      .values({
        tenant_id: ctx.tenantId,
        id: randomUUID(),
        run_id: runId,
        seq,
        data,
      })
      .execute();
    return seq;
  });
}

export function consumeBudget(used: {
  llmCalls: number;
  toolCalls: number;
  tokens: number;
  startedAt: number;
}): void {
  if (used.llmCalls > DEFAULT_BUDGETS.llmCalls || used.toolCalls > DEFAULT_BUDGETS.toolCalls) {
    throw new DomainError('BUDGET_EXCEEDED', 'Run budget exhausted');
  }
  if (used.tokens > DEFAULT_BUDGETS.tokens) {
    throw new DomainError('BUDGET_EXCEEDED', 'Token budget exhausted');
  }
  if (Date.now() - used.startedAt > DEFAULT_BUDGETS.activeMs) {
    throw new DomainError('BUDGET_EXCEEDED', 'Active time budget exhausted');
  }
}
