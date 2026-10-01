import { Annotation, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { EMPTY_USAGE, type ActorContext, type DomainDb, type Embedder } from '@commerce/domain';
import { routeMessage, type Intent } from '../router/index.js';
import { BudgetExceededError, RunCancelledError, type Meter } from './budget.js';
import type { EvidenceItem, ToolGateway } from './gateway.js';
import { explainInventory, investigateOrder, recommendProductsForRun } from './specialists.js';
import type { Synthesizer } from './synthesizer.js';
import type {
  ActionResult,
  ApprovalOutcome,
  CancellationProposal,
  RouteSnapshot,
  RunResult,
  RunUsage,
  SpecialistFinding,
} from './types.js';

export interface UiContext {
  readonly intent: Intent;
  readonly orderId?: string;
}

const last = <T>(fallback: T) =>
  Annotation<T>({ reducer: (_current: T, next: T) => next, default: () => fallback });

/** Durable state of one run. Only data and decisions are stored; no hidden reasoning. */
export const RunState = Annotation.Root({
  runId: last<string>(''),
  message: last<string>(''),
  uiContext: last<UiContext | null>(null),
  route: last<RouteSnapshot | null>(null),
  findings: Annotation<SpecialistFinding[]>({
    reducer: (current, next) => current.concat(next),
    default: () => [],
  }),
  evidence: Annotation<EvidenceItem[]>({
    reducer: (current, next) => current.concat(next),
    default: () => [],
  }),
  approval: last<ApprovalOutcome | null>(null),
  action: last<ActionResult | null>(null),
  usage: last<RunUsage>(EMPTY_USAGE),
  halted: last<RunResult | null>(null),
  result: last<RunResult | null>(null),
});
export type RunStateValue = typeof RunState.State;

/** Per-execution dependencies. The meter is set by the executor once the durable usage is known. */
export interface GraphRuntime {
  readonly db: DomainDb;
  readonly ctx: ActorContext;
  readonly embedder: Embedder;
  readonly synthesizer: Synthesizer;
  gateway: ToolGateway;
  meter: Meter;
  readonly region: string;
  readonly locale: string;
}

const SPECIALIST_ORDER: readonly Intent[] = [
  'order_investigation',
  'product_recommendation',
  'inventory_anomaly',
];

/** Turns budget and cancellation stops into a controlled, labelled end instead of an error. */
function stopFor(error: unknown, findings: readonly SpecialistFinding[]): RunResult {
  if (error instanceof BudgetExceededError) {
    const facts = findings.reduce((n, f) => n + f.facts.length, 0);
    return {
      outcome: 'BUDGET_EXCEEDED',
      partial: true,
      summary: `Respuesta parcial: se agotó el presupuesto del run (${error.dimension}) y no se hicieron más llamadas. Evidencia reunida hasta ese punto: ${String(facts)} hechos. Puedo derivarte a soporte.`,
    };
  }
  if (error instanceof RunCancelledError) {
    return {
      outcome: 'CANCELLED',
      partial: true,
      summary: 'El run fue cancelado; no se ejecutaron más pasos.',
    };
  }
  throw error;
}

/**
 * Supervisor graph: deterministic routing, bounded specialists, an approval interrupt and a
 * single place where the only privileged command can run. Business rules stay in the domain.
 */
export function buildSupervisorGraph(rt: GraphRuntime) {
  return new StateGraph(RunState)
    .addNode('router', async (state) => {
      try {
        await rt.gateway.ensureActive();
        const route = routeMessage(
          state.message,
          state.uiContext ? { uiContext: state.uiContext } : {},
        );
        if (route.modelCalls > 0) rt.meter.addModelCalls(route.modelCalls);
        if (rt.meter.exhausted()) throw new BudgetExceededError(rt.meter.exhausted() ?? 'llmCalls');
        return { route, usage: rt.meter.usage() };
      } catch (error) {
        return { halted: stopFor(error, []), usage: rt.meter.usage() };
      }
    })
    .addNode('clarify', (state) => {
      const reason = state.route?.reason;
      const summary =
        reason === 'multiple_order_ids'
          ? 'Mencionaste más de una orden. ¿Sobre cuál querés que investigue? No elijo por vos.'
          : reason === 'missing_order_id'
            ? 'Necesito el número de la orden para investigarla. No lo infiero ni busco órdenes por mi cuenta.'
            : 'No estoy seguro de qué necesitás. ¿Es sobre una orden, una recomendación de productos o alertas de inventario?';
      return {
        result: { outcome: 'CLARIFICATION_REQUESTED', partial: false, summary } satisfies RunResult,
      };
    })
    .addNode('refuse', () => ({
      result: {
        outcome: 'REFUSED',
        partial: false,
        summary:
          'Eso está fuera de lo que puedo hacer: consulto órdenes, recomiendo productos elegibles y explico alertas de inventario. No cambio precios, stock, datos de cuenta ni apruebo acciones.',
      } satisfies RunResult,
    }))
    .addNode('specialists', async (state) => {
      const route = state.route;
      if (!route) return {};
      const deps = { ...rt };
      const findings: SpecialistFinding[] = [];
      try {
        for (const intent of SPECIALIST_ORDER.filter((i) => route.intents.includes(i))) {
          if (intent === 'order_investigation')
            findings.push(await investigateOrder(deps, route.slots));
          if (intent === 'product_recommendation') {
            findings.push(await recommendProductsForRun(deps, state.message, route.slots));
          }
          if (intent === 'inventory_anomaly')
            findings.push(await explainInventory(deps, route.slots));
        }
        return { findings, evidence: evidenceOf(findings), usage: rt.meter.usage() };
      } catch (error) {
        return {
          findings,
          evidence: evidenceOf(findings),
          halted: stopFor(error, findings),
          usage: rt.meter.usage(),
        };
      }
    })
    .addNode('await_approval', (state) => {
      const proposal = proposalOf(state.findings);
      // The resume value comes from the executor, which reads the approval from the database;
      // nothing the model or the user types can produce it.
      const approval = interrupt<
        { kind: 'approval_required'; proposal: CancellationProposal | undefined },
        ApprovalOutcome
      >({
        kind: 'approval_required',
        proposal,
      });
      return { approval };
    })
    .addNode('execute_action', async (state) => {
      const proposal = proposalOf(state.findings);
      if (!proposal || state.approval?.status !== 'APPROVED') return {};
      try {
        const result = await rt.gateway.call('support', 'update_order', {
          order_id: proposal.orderId,
          action: proposal.action,
          reason_code: proposal.reasonCode,
          expected_version: proposal.expectedVersion,
          action_request_id: state.approval.actionRequestId,
          // One key per run and request: a retried execution replays the stored result.
          idempotency_key: `run-${state.runId}`,
        });
        const action: ActionResult = result.ok
          ? {
              ok: true,
              orderStatus: (result.data as { status: string }).status,
              version: (result.data as { version: number }).version,
            }
          : { ok: false, errorCode: result.error.code };
        return { action, usage: rt.meter.usage() };
      } catch (error) {
        return { halted: stopFor(error, state.findings), usage: rt.meter.usage() };
      }
    })
    .addNode('synthesize', async (state) => {
      if (state.halted) return { result: state.halted };
      const actionNote = actionSummary(state);
      try {
        rt.meter.beforeModelCall(rt.synthesizer.estimateTokens(state.findings));
        const synthesis = await rt.synthesizer.synthesize(state.findings);
        return {
          result: {
            outcome: actionNote?.outcome ?? 'ANSWERED',
            partial: state.findings.some((f) => f.status === 'partial'),
            summary: [synthesis.text, actionNote?.text].filter(Boolean).join('\n\n'),
          } satisfies RunResult,
          usage: rt.meter.usage(),
        };
      } catch (error) {
        if (!(error instanceof BudgetExceededError)) throw error;
        // No model budget left: answer with the facts verbatim, labelled as partial.
        return {
          result: {
            outcome: actionNote?.outcome ?? 'BUDGET_EXCEEDED',
            partial: true,
            summary: [
              'Respuesta parcial (presupuesto de modelo agotado); hechos sin redactar:',
              ...state.findings.flatMap((f) =>
                f.facts.map((fact) => `- ${fact.text} [${fact.evidence.ref}]`),
              ),
              actionNote?.text,
            ]
              .filter(Boolean)
              .join('\n'),
          } satisfies RunResult,
          usage: rt.meter.usage(),
        };
      }
    })
    .addEdge(START, 'router')
    .addConditionalEdges('router', (state) =>
      state.halted
        ? 'synthesize'
        : state.route?.decision === 'clarify'
          ? 'clarify'
          : state.route?.decision === 'out_of_scope'
            ? 'refuse'
            : 'specialists',
    )
    .addConditionalEdges('specialists', (state) => {
      if (state.halted) return 'synthesize';
      const proposal = proposalOf(state.findings);
      return proposal?.eligible ? 'await_approval' : 'synthesize';
    })
    .addConditionalEdges('await_approval', (state) =>
      state.approval?.status === 'APPROVED' ? 'execute_action' : 'synthesize',
    )
    .addEdge('execute_action', 'synthesize')
    .addEdge('clarify', END)
    .addEdge('refuse', END)
    .addEdge('synthesize', END);
}

function proposalOf(findings: readonly SpecialistFinding[]): CancellationProposal | undefined {
  return findings.find((f) => f.proposal)?.proposal;
}

function evidenceOf(findings: readonly SpecialistFinding[]): EvidenceItem[] {
  return findings.flatMap((f) => [
    ...f.facts.map((fact) => fact.evidence),
    ...(f.items ?? []).flatMap((i) => i.evidence.slice(1)),
  ]);
}

function actionSummary(
  state: RunStateValue,
): { outcome: RunResult['outcome']; text: string } | undefined {
  if (!state.approval) return undefined;
  if (state.approval.status !== 'APPROVED') {
    return {
      outcome: 'ACTION_REJECTED',
      text: `La solicitud de cancelación no se ejecutó (${state.approval.status}); no hubo cambios en la orden.`,
    };
  }
  if (state.action?.ok) {
    return {
      outcome: 'ACTION_EXECUTED',
      text: `Cancelación solicitada: la orden quedó en ${state.action.orderStatus ?? 'CANCELLATION_REQUESTED'} (versión ${String(state.action.version ?? '')}). Es una solicitud pendiente del proceso comercial; la orden no está cancelada.`,
    };
  }
  return {
    outcome: 'ACTION_FAILED',
    text: `La solicitud aprobada no pudo ejecutarse (${state.action?.errorCode ?? 'error'}); no hubo cambios. Puedo derivarte a soporte.`,
  };
}
