import type { RunUsage } from '@commerce/domain';
import type { Intent, RouteResult } from '../router/index.js';
import type { EvidenceItem } from './gateway.js';

/** A statement read from a tool or document, with the evidence it came from. */
export interface Fact {
  readonly text: string;
  readonly evidence: EvidenceItem;
}

export interface EscalationNote {
  readonly required: boolean;
  readonly ruleVersion: string;
  readonly reasons: readonly string[];
}

export interface CancellationProposal {
  readonly kind: 'update_order';
  readonly orderId: string;
  readonly action: 'request_cancellation';
  readonly reasonCode: 'customer_request';
  readonly expectedVersion: number;
  /** Advisory pre-check from the facts read; the domain command re-checks at commit. */
  readonly eligible: boolean;
  readonly ineligibleReason?: string;
}

export interface RecommendationItem {
  readonly skuId: string;
  readonly skuCode: string;
  readonly title: string;
  readonly priceMinor: number;
  readonly currency: string;
  readonly ramGb: number | null;
  readonly available: number;
  readonly observedAt: string;
  readonly justification: string;
  readonly evidence: readonly EvidenceItem[];
}

export interface AlertExplanation {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly severity: string;
  readonly status: string;
  readonly skuId: string | null;
  readonly explanation: string;
  readonly evidence: EvidenceItem;
}

export type SpecialistName = 'order' | 'recommendation' | 'inventory';

export interface SpecialistFinding {
  readonly specialist: SpecialistName;
  /** partial: some data missing (budget, unavailable dependency); not_found/forbidden: no data. */
  readonly status: 'ok' | 'partial' | 'not_found' | 'forbidden' | 'no_candidates';
  readonly facts: readonly Fact[];
  /** Interpretations derived from facts; always labelled as such to the user. */
  readonly inferences: readonly string[];
  readonly uncertainty: readonly string[];
  readonly nextSteps: readonly string[];
  readonly escalation?: EscalationNote;
  readonly proposal?: CancellationProposal;
  readonly items?: readonly RecommendationItem[];
  readonly alerts?: readonly AlertExplanation[];
}

export type ApprovalOutcome =
  | { readonly status: 'APPROVED'; readonly actionRequestId: string }
  | {
      readonly status: 'REJECTED' | 'EXPIRED' | 'STALE' | 'FAILED';
      readonly actionRequestId: string;
    };

export interface ActionResult {
  readonly ok: boolean;
  readonly orderStatus?: string;
  readonly version?: number;
  readonly errorCode?: string;
}

export interface RunResult {
  readonly outcome:
    | 'ANSWERED'
    | 'CLARIFICATION_REQUESTED'
    | 'REFUSED'
    | 'BUDGET_EXCEEDED'
    | 'CANCELLED'
    | 'ACTION_EXECUTED'
    | 'ACTION_REJECTED'
    | 'ACTION_FAILED';
  readonly summary: string;
  /** True when part of the work was skipped; the summary says which part. */
  readonly partial: boolean;
}

export interface RouteSnapshot extends RouteResult {
  readonly intents: readonly Intent[];
}

export type { RunUsage };
