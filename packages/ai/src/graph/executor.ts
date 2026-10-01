import { Command } from '@langchain/langgraph';
import { trace } from '@opentelemetry/api';
import {
  EMPTY_USAGE,
  claimAgentRun,
  executorActor,
  isDomainError,
  recordEvidence,
  releaseAgentRun,
  resolveActor,
  runApprovalOutcome,
  updateAgentRun,
  type ActorContext,
  type DomainDb,
  type Embedder,
  type RunUsage,
} from '@commerce/domain';
import { Meter } from './budget.js';
import { TenantCheckpointSaver } from './checkpointer.js';
import { ToolGateway, type ToolCallObservation } from './gateway.js';
import {
  buildSupervisorGraph,
  type GraphRuntime,
  type RunStateValue,
  type UiContext,
} from './graph.js';
import type { Synthesizer } from './synthesizer.js';
import type { CancellationProposal } from './types.js';

export interface ExecutorDeps {
  readonly db: DomainDb;
  readonly embedder: Embedder;
  readonly synthesizer: Synthesizer;
  readonly workerId: string;
  /** Lease while one worker drives a run; an expired lease lets another worker take over. */
  readonly leaseMs?: number;
  readonly region?: string;
  readonly locale?: string;
  /** Evaluation hook: observes tool calls (arguments and results) without affecting them. */
  readonly onToolCall?: (observation: ToolCallObservation) => void;
}

export type ExecutionStatus = 'SKIPPED' | 'WAITING_HUMAN' | 'COMPLETED' | 'CANCELLED' | 'FAILED';

export interface ExecutionReport {
  readonly runId: string;
  readonly status: ExecutionStatus;
  readonly outcome?: string;
}

/**
 * Drives one run as far as it can go: start, resume after a crash from the last durable
 * checkpoint, or resume after a human decision read from the database. Every call re-resolves the
 * run owner's membership, so a revoked user's run ends without effects.
 */
export async function executeRun(
  deps: ExecutorDeps,
  tenantId: string,
  runId: string,
): Promise<ExecutionReport> {
  return tracer.startActiveSpan(
    'agent.run',
    { attributes: { 'commerce.run_id': runId, 'commerce.worker_id': deps.workerId } },
    async (span) => {
      try {
        const report = await driveRun(deps, tenantId, runId);
        span.setAttribute('commerce.run_status', report.status);
        if (report.outcome) span.setAttribute('commerce.run_outcome', report.outcome);
        return report;
      } finally {
        span.end();
      }
    },
  );
}

const tracer = trace.getTracer('@commerce/ai');

async function driveRun(
  deps: ExecutorDeps,
  tenantId: string,
  runId: string,
): Promise<ExecutionReport> {
  const { db } = deps;
  const claimed = await claimAgentRun(db, tenantId, runId, deps.workerId, deps.leaseMs ?? 120_000);
  if (!claimed) return { runId, status: 'SKIPPED' };
  const executor = executorActor(tenantId);
  try {
    let ctx: ActorContext;
    try {
      ctx = await resolveActor(db, {
        tenantId,
        subjectId: claimed.subjectId,
        correlationId: `run-${runId}`,
      });
    } catch (error) {
      if (!isDomainError(error) || error.code !== 'FORBIDDEN') throw error;
      await updateAgentRun(db, executor, runId, {
        status: 'FAILED',
        outcome: 'ACCESS_REVOKED',
        event: {
          type: 'completed',
          status: 'FAILED',
          outcome: 'ACCESS_REVOKED',
          summary: 'El acceso del solicitante fue revocado; el run terminó sin ejecutar acciones.',
        },
      });
      return { runId, status: 'FAILED', outcome: 'ACCESS_REVOKED' };
    }

    const saver = await TenantCheckpointSaver.forThread(db, ctx, runId);
    const placeholder = new Meter(claimed.budgets, claimed.usage);
    const rt: GraphRuntime = {
      db,
      ctx,
      embedder: deps.embedder,
      synthesizer: deps.synthesizer,
      meter: placeholder,
      gateway: new ToolGateway(db, ctx, runId, placeholder),
      region: deps.region ?? 'us-east',
      locale: deps.locale ?? 'es',
    };
    const graph = buildSupervisorGraph(rt).compile({ checkpointer: saver });
    const config = { configurable: { thread_id: runId } };
    const before = await graph.getState(config);
    const values = before.values as Partial<RunStateValue>;
    const meter = new Meter(claimed.budgets, maxUsage(claimed.usage, values.usage));
    rt.meter = meter;
    rt.gateway = new ToolGateway(db, ctx, runId, meter, deps.onToolCall);

    const started = Object.keys(values).length > 0 && before.createdAt !== undefined;
    let input: unknown;
    if (!started) {
      input = {
        runId,
        message: claimed.input.message,
        uiContext: (claimed.input.uiContext as UiContext | undefined) ?? null,
        usage: claimed.usage,
      };
    } else if (before.next.includes('await_approval')) {
      const decision = await runApprovalOutcome(db, ctx, runId);
      if (!decision) {
        await updateAgentRun(db, ctx, runId, { status: 'WAITING_HUMAN' });
        return { runId, status: 'WAITING_HUMAN' };
      }
      input = new Command({ resume: decision });
    } else if (before.next.length > 0) {
      // A previous worker stopped mid-run: continue from the last durable checkpoint.
      input = null;
    } else {
      return await finish(deps, ctx, runId, values, meter.usage());
    }

    await updateAgentRun(db, ctx, runId, {
      status: 'RUNNING',
      event: { type: 'status', status: 'RUNNING' },
    });
    await graph.invoke(input as never, config);
    const after = await graph.getState(config);
    const state = after.values as RunStateValue;
    if (after.next.includes('await_approval')) {
      const proposal = state.findings.find((f) => f.proposal)?.proposal;
      await updateAgentRun(db, ctx, runId, {
        status: 'WAITING_HUMAN',
        intent: state.route?.intents.join('+') ?? null,
        usage: meter.usage(),
        event: {
          type: 'approval_required',
          status: 'WAITING_HUMAN',
          proposal: proposalView(proposal),
          findings: findingsView(state),
        },
      });
      return { runId, status: 'WAITING_HUMAN' };
    }
    return await finish(deps, ctx, runId, state, meter.usage());
  } catch (error) {
    await updateAgentRun(db, executor, runId, {
      status: 'FAILED',
      outcome: 'ERROR',
      event: {
        type: 'completed',
        status: 'FAILED',
        outcome: 'ERROR',
        summary: 'El run falló por un error interno; no se ejecutaron acciones adicionales.',
      },
    });
    throw error;
  } finally {
    await releaseAgentRun(db, tenantId, runId, deps.workerId);
  }
}

async function finish(
  deps: ExecutorDeps,
  ctx: ActorContext,
  runId: string,
  state: Partial<RunStateValue>,
  usage: RunUsage,
): Promise<ExecutionReport> {
  const result = state.result ?? state.halted;
  const outcome = result?.outcome ?? 'ANSWERED';
  const status = outcome === 'CANCELLED' ? 'CANCELLED' : 'COMPLETED';
  if (state.evidence && state.route?.decision === 'route') {
    await recordEvidence(deps.db, ctx, runId, evidenceRows(state as RunStateValue));
  }
  await updateAgentRun(deps.db, ctx, runId, {
    status,
    outcome,
    intent: state.route?.intents.join('+') ?? null,
    usage,
    event: {
      type: 'completed',
      status,
      outcome,
      partial: result?.partial ?? false,
      summary: result?.summary ?? '',
      findings: state.findings ? findingsView(state as RunStateValue) : [],
      provider: deps.synthesizer.info,
    },
  });
  return { runId, status, outcome };
}

/** Client-visible projection: data, citations and decisions only. */
function findingsView(state: RunStateValue) {
  return state.findings.map((f) => ({
    specialist: f.specialist,
    status: f.status,
    facts: f.facts.map((fact) => ({ text: fact.text, evidence: fact.evidence })),
    inferences: f.inferences,
    uncertainty: f.uncertainty,
    next_steps: f.nextSteps,
    ...(f.escalation ? { escalation: f.escalation } : {}),
    ...(f.items ? { items: f.items } : {}),
    ...(f.alerts ? { alerts: f.alerts } : {}),
  }));
}

function proposalView(proposal: CancellationProposal | undefined) {
  if (!proposal) return null;
  return {
    tool: proposal.kind,
    order_id: proposal.orderId,
    action: proposal.action,
    reason_code: proposal.reasonCode,
    expected_version: proposal.expectedVersion,
  };
}

function evidenceRows(state: RunStateValue) {
  const seen = new Set<string>();
  return state.evidence
    .filter((e) => {
      const key = `${e.kind}|${e.ref}|${e.version}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((e) => ({
      kind: e.kind,
      resourceRef: e.ref,
      version: e.version,
      observedAt: e.observedAt,
      ...(e.documentVersionId ? { documentVersionId: e.documentVersionId } : {}),
    }));
}

function maxUsage(a: RunUsage, b: RunUsage | undefined): RunUsage {
  const other = b ?? EMPTY_USAGE;
  return {
    llmCalls: Math.max(a.llmCalls, other.llmCalls),
    toolCalls: Math.max(a.toolCalls, other.toolCalls),
    tokens: Math.max(a.tokens, other.tokens),
    activeMs: Math.max(a.activeMs, other.activeMs),
  };
}

/** BullMQ queue name for run notifications; the job carries ids only, never authority. */
export const AGENT_RUN_QUEUE = 'agent-runs';
