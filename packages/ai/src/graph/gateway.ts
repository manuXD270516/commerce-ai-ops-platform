import { randomUUID } from 'node:crypto';
import { isRunCancelled, type ActorContext, type DomainDb } from '@commerce/domain';
import { invokeTool, type Scope, type ToolResult } from '@commerce/tools';
import { RunCancelledError, type Meter } from './budget.js';

/**
 * Tool profiles per specialist (docs/agents-security-mcp.md). They narrow, never widen, what the
 * run owner's role and the tool policy already allow: effective scopes are the intersection.
 */
export const SPECIALIST_PROFILES = {
  order: ['orders:read', 'shipping:read'],
  support: ['orders:read', 'orders:request-cancellation'],
  recommendation: ['catalog:read', 'inventory:read'],
  catalog: ['catalog:read'],
  inventory: ['inventory:read', 'catalog:read'],
} as const satisfies Record<string, readonly Scope[]>;
export type SpecialistProfile = keyof typeof SPECIALIST_PROFILES;

export interface EvidenceItem {
  readonly kind: string;
  readonly ref: string;
  readonly version: string;
  readonly observedAt: string;
  readonly source: 'sql' | 'knowledge';
  readonly documentVersionId?: string;
}

export interface ToolCallRecord {
  readonly toolCallId: string;
  readonly tool: string;
  readonly profile: SpecialistProfile;
  readonly ok: boolean;
  readonly errorCode?: string;
}

/**
 * The only path from the graph to tools. Before every call it checks cancellation and reserves
 * budget; the call itself goes through @commerce/tools with the run owner's context and the
 * specialist profile, exactly like an MCP client.
 */
export class ToolGateway {
  readonly calls: ToolCallRecord[] = [];

  constructor(
    private readonly db: DomainDb,
    private readonly ctx: ActorContext,
    private readonly runId: string,
    private readonly meter: Meter,
  ) {}

  async ensureActive(): Promise<void> {
    if (await isRunCancelled(this.db, this.ctx, this.runId)) throw new RunCancelledError();
  }

  async call(
    profile: SpecialistProfile,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    await this.ensureActive();
    this.meter.beforeToolCall();
    const toolCallId = randomUUID();
    const result = await invokeTool(this.db, this.ctx, {
      name: tool,
      args,
      profileScopes: SPECIALIST_PROFILES[profile],
      toolCallId,
    });
    this.calls.push({
      toolCallId,
      tool,
      profile,
      ok: result.ok,
      ...(result.ok ? {} : { errorCode: result.error.code }),
    });
    return result;
  }

  /** Authorized knowledge retrieval counts against the same tool budget. */
  async retrieval<T>(fn: () => Promise<T>): Promise<T> {
    await this.ensureActive();
    this.meter.beforeToolCall();
    return fn();
  }
}
