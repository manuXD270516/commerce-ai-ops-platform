import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import { INTENTS, SELECTED_PROVIDER, type Intent } from '@commerce/ai';
import {
  DomainError,
  createAgentRun,
  getAgentRun,
  listRunEvidence,
  listRunEvents,
  requestRunCancellation,
  type AgentRunRecord,
} from '@commerce/domain';
import type { Request, Response } from 'express';
import { DOMAIN, DomainService } from './domain.service.js';
import { RUN_DISPATCHER, type RunDispatcher } from './run-dispatcher.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
/** One SSE connection lives at most this long; the client reconnects with Last-Event-ID. */
const SSE_MAX_MS = 5 * 60 * 1000;
const SSE_POLL_MS = 400;
const SSE_HEARTBEAT_MS = 15_000;

function view(run: AgentRunRecord) {
  return {
    id: run.id,
    status: run.status,
    outcome: run.outcome,
    intent: run.intent,
    usage: run.usage,
    budgets: run.budgets,
    router_version: run.routerVersion,
    model_version: run.modelVersion,
    prompt_version: run.promptVersion,
    cancel_requested: run.cancelRequested,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    observed_at: new Date().toISOString(),
  };
}

@Controller('v1/agent-runs')
export class RunsController {
  constructor(
    @Inject(DOMAIN) private readonly domain: DomainService,
    @Inject(RUN_DISPATCHER) private readonly dispatcher: RunDispatcher,
  ) {}

  /** 202 + run id: the run executes asynchronously and is followed through /events. */
  @Post()
  async create(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { message?: unknown; ui_context?: { intent?: unknown; order_id?: unknown } },
  ) {
    const ctx = await this.domain.actorOf(req);
    if (typeof body.message !== 'string') {
      throw new DomainError('VALIDATION_ERROR', 'message is required', { field: 'message' });
    }
    const ui = body.ui_context;
    if (
      ui !== undefined &&
      (!INTENTS.includes(ui.intent as Intent) ||
        (ui.order_id !== undefined && (typeof ui.order_id !== 'string' || !UUID.test(ui.order_id))))
    ) {
      throw new DomainError('VALIDATION_ERROR', 'invalid ui_context', { field: 'ui_context' });
    }
    const run = await createAgentRun(this.domain.requireDb(), ctx, {
      message: body.message,
      ...(ui
        ? {
            uiContext: {
              intent: ui.intent as Intent,
              ...(typeof ui.order_id === 'string' ? { orderId: ui.order_id } : {}),
            },
          }
        : {}),
      promptVersion: SELECTED_PROVIDER.promptVersion,
      modelVersion: SELECTED_PROVIDER.synthesizer,
      routerVersion: SELECTED_PROVIDER.router,
    });
    await this.dispatcher.dispatch(ctx.tenantId, run.id);
    res.status(202);
    return view(run);
  }

  @Get(':id')
  async get(@Req() req: Request, @Param('id') id: string) {
    const ctx = await this.domain.actorOf(req);
    return view(await getAgentRun(this.domain.requireDb(), ctx, assertUuid(id)));
  }

  @Get(':id/evidence')
  async evidence(@Req() req: Request, @Param('id') id: string) {
    const ctx = await this.domain.actorOf(req);
    const items = await listRunEvidence(this.domain.requireDb(), ctx, assertUuid(id));
    return {
      items: items.map((e) => ({
        kind: e.kind,
        resource_ref: e.resourceRef,
        version: e.version,
        observed_at: e.observedAt,
        document_version_id: e.documentVersionId ?? null,
      })),
    };
  }

  @Post(':id/cancel')
  async cancel(@Req() req: Request, @Param('id') id: string) {
    const ctx = await this.domain.actorOf(req);
    return view(await requestRunCancellation(this.domain.requireDb(), ctx, assertUuid(id)));
  }

  /**
   * Server-sent events from the durable run_events table. A reconnecting client sends
   * Last-Event-ID (or ?after=) and receives only what it missed; reconnecting never starts a run.
   * Events carry status, findings, citations and decisions, never hidden reasoning.
   */
  @Get(':id/events')
  async events(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id') id: string,
    @Query('after') after?: string,
  ) {
    const ctx = await this.domain.actorOf(req);
    const db = this.domain.requireDb();
    const runId = assertUuid(id);
    await getAgentRun(db, ctx, runId);
    const header = req.headers['last-event-id'];
    const parsed = Number(Array.isArray(header) ? header[0] : (header ?? after ?? -1));
    let cursor = Number.isInteger(parsed) && parsed >= -1 ? parsed : -1;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const connection = { closed: false };
    req.on('close', () => {
      connection.closed = true;
    });
    const deadline = Date.now() + SSE_MAX_MS;
    let lastWrite = Date.now();
    try {
      res.write('retry: 2000\n\n');
      while (!connection.closed && Date.now() < deadline) {
        const events = await listRunEvents(db, ctx, runId, cursor);
        for (const e of events) {
          const data = e.data as { type?: string };
          res.write(
            `id: ${String(e.seq)}\nevent: ${data.type ?? 'message'}\ndata: ${JSON.stringify({ ...data, seq: e.seq, recorded_at: e.recordedAt })}\n\n`,
          );
          cursor = e.seq;
          lastWrite = Date.now();
        }
        if (events.length === 0) {
          const run = await getAgentRun(db, ctx, runId);
          if (TERMINAL.has(run.status)) break;
          if (Date.now() - lastWrite > SSE_HEARTBEAT_MS) {
            res.write(': heartbeat\n\n');
            lastWrite = Date.now();
          }
          await new Promise((resolve) => setTimeout(resolve, SSE_POLL_MS));
        }
      }
    } finally {
      res.end();
    }
  }
}

function assertUuid(id: string): string {
  if (!UUID.test(id)) throw new DomainError('NOT_FOUND', 'Run not found');
  return id;
}
