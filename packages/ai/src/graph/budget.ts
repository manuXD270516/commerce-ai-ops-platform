import type { RunBudgets, RunUsage } from '@commerce/domain';

export class BudgetExceededError extends Error {
  constructor(readonly dimension: keyof RunBudgets) {
    super(`Run budget exhausted: ${dimension}`);
    this.name = 'BudgetExceededError';
  }
}

export class RunCancelledError extends Error {
  constructor() {
    super('Run was cancelled');
    this.name = 'RunCancelledError';
  }
}

/**
 * Counts model calls, tool calls, tokens and active time for one run. It is checked before every
 * call, so an exhausted budget means the call is not made. Active time only accrues while the
 * executor is driving the graph; waiting for a human adds nothing.
 */
export class Meter {
  private llmCalls: number;
  private toolCalls: number;
  private tokens: number;
  private readonly activeBefore: number;
  private readonly segmentStart: number;

  constructor(
    readonly budgets: RunBudgets,
    usage: RunUsage,
    private readonly clock: () => number = Date.now,
  ) {
    this.llmCalls = usage.llmCalls;
    this.toolCalls = usage.toolCalls;
    this.tokens = usage.tokens;
    this.activeBefore = usage.activeMs;
    this.segmentStart = clock();
  }

  usage(): RunUsage {
    return {
      llmCalls: this.llmCalls,
      toolCalls: this.toolCalls,
      tokens: this.tokens,
      activeMs: this.activeBefore + (this.clock() - this.segmentStart),
    };
  }

  /** First dimension already at or over its limit, if any. */
  exhausted(): keyof RunBudgets | undefined {
    const u = this.usage();
    if (u.activeMs >= this.budgets.activeMs) return 'activeMs';
    if (u.tokens >= this.budgets.tokens) return 'tokens';
    if (u.toolCalls >= this.budgets.toolCalls) return 'toolCalls';
    if (u.llmCalls >= this.budgets.llmCalls) return 'llmCalls';
    return undefined;
  }

  beforeToolCall(): void {
    const u = this.usage();
    if (u.activeMs >= this.budgets.activeMs) throw new BudgetExceededError('activeMs');
    if (u.toolCalls + 1 > this.budgets.toolCalls) throw new BudgetExceededError('toolCalls');
    this.toolCalls += 1;
  }

  /** Reserves a model call with its estimated tokens; refuses it if either limit would be passed. */
  beforeModelCall(estimatedTokens: number): void {
    const u = this.usage();
    if (u.activeMs >= this.budgets.activeMs) throw new BudgetExceededError('activeMs');
    if (u.llmCalls + 1 > this.budgets.llmCalls) throw new BudgetExceededError('llmCalls');
    if (u.tokens + estimatedTokens > this.budgets.tokens) throw new BudgetExceededError('tokens');
    this.llmCalls += 1;
    this.tokens += estimatedTokens;
  }

  /** Records a call made outside beforeModelCall (e.g. the local router classifier). */
  addModelCalls(calls: number, tokens = 0): void {
    this.llmCalls += calls;
    this.tokens += tokens;
  }
}
