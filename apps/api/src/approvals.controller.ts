import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  CANCELLATION_EFFECT,
  DomainError,
  createActionRequest,
  decideApproval,
  getActionRequest,
  getOrder,
  listActionRequests,
  type ActionRequestRecord,
  type ActorContext,
  type DomainDb,
} from '@commerce/domain';
import { invokeTool } from '@commerce/tools';
import type { Request, Response } from 'express';
import { DOMAIN, DomainService } from './domain.service.js';
import { RUN_DISPATCHER, type RunDispatcher } from './run-dispatcher.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9._:-]{8,128}$/;

function requireKey(key: string | undefined): string {
  if (!key || !KEY.test(key)) {
    throw new DomainError(
      'VALIDATION_ERROR',
      'Idempotency-Key header (8-128 safe characters) is required',
      {
        field: 'idempotency-key',
      },
    );
  }
  return key;
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new DomainError('VALIDATION_ERROR', `${field} must be a UUID`, { field });
  }
  return value;
}

/**
 * What an approver reviews: resource, exact effect, canonical arguments, version, expiry and the
 * order facts read now. The decision itself is enforced again by the backend at commit.
 */
async function view(db: DomainDb, ctx: ActorContext, r: ActionRequestRecord) {
  let order: { status: string; version: number } | undefined;
  try {
    const o = await getOrder(db, ctx, r.resourceId);
    order = { status: o.status, version: o.version };
  } catch {
    order = undefined;
  }
  return {
    id: r.id,
    tool: r.tool,
    resource: { type: 'order', id: r.resourceId },
    effect: CANCELLATION_EFFECT,
    canonical_args: r.canonicalArgs,
    canonical_args_hash: r.canonicalArgsHash,
    expected_version: r.expectedVersion,
    policy_version: r.policyVersion,
    status: r.status,
    run_id: r.runId,
    requester: r.requesterSubjectId,
    created_at: r.createdAt,
    expires_at: r.expiresAt,
    decision: r.decision ?? null,
    current_order: order ?? null,
    // A request is stale for review when the order moved since it was created.
    stale: order !== undefined && order.version !== r.expectedVersion,
    observed_at: new Date().toISOString(),
  };
}

@Controller('v1')
export class ApprovalsController {
  constructor(
    @Inject(DOMAIN) private readonly domain: DomainService,
    @Inject(RUN_DISPATCHER) private readonly dispatcher: RunDispatcher,
  ) {}

  /** The user's explicit confirmation of a proposed cancellation; creates a PENDING request. */
  @Post('action-requests')
  async create(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body()
    body: {
      order_id?: unknown;
      reason_code?: unknown;
      expected_version?: unknown;
      run_id?: unknown;
    },
  ) {
    const ctx = await this.domain.actorOf(req);
    const db = this.domain.requireDb();
    if (typeof body.expected_version !== 'number' || typeof body.reason_code !== 'string') {
      throw new DomainError('VALIDATION_ERROR', 'reason_code and expected_version are required');
    }
    const record = await createActionRequest(db, ctx, {
      orderId: requireUuid(body.order_id, 'order_id'),
      reasonCode: body.reason_code,
      expectedVersion: body.expected_version,
      ...(body.run_id === undefined ? {} : { runId: requireUuid(body.run_id, 'run_id') }),
      idempotencyKey: requireKey(idempotencyKey),
    });
    res.status(201);
    return view(db, ctx, record);
  }

  @Get('action-requests')
  async list(@Req() req: Request, @Query('status') status?: string) {
    const ctx = await this.domain.actorOf(req);
    const db = this.domain.requireDb();
    const items = await listActionRequests(db, ctx, status ? { status } : {});
    return { items: await Promise.all(items.map((r) => view(db, ctx, r))) };
  }

  @Get('action-requests/:id')
  async get(@Req() req: Request, @Param('id') id: string) {
    const ctx = await this.domain.actorOf(req);
    const db = this.domain.requireDb();
    return view(db, ctx, await getActionRequest(db, ctx, requireUuid(id, 'id')));
  }

  /** Approver decision; the waiting run (if any) is resumed and re-checks everything itself. */
  @Post('approvals/:id/decision')
  async decide(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { decision?: unknown; reason?: unknown },
  ) {
    const ctx = await this.domain.actorOf(req);
    const db = this.domain.requireDb();
    const record = await decideApproval(db, ctx, {
      actionRequestId: requireUuid(id, 'id'),
      decision: body.decision as 'APPROVED' | 'REJECTED',
      ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
    });
    if (record.runId) await this.dispatcher.dispatch(ctx.tenantId, record.runId);
    return view(db, ctx, record);
  }

  /** Direct execution by the requester, through the same tool enforcement as MCP and agents. */
  @Post('orders/:id/actions')
  async execute(
    @Req() req: Request,
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    const ctx = await this.domain.actorOf(req);
    const result = await invokeTool(this.domain.requireDb(), ctx, {
      name: 'update_order',
      args: {
        ...body,
        order_id: requireUuid(id, 'id'),
        idempotency_key: requireKey(idempotencyKey),
      },
    });
    if (!result.ok) {
      throw new DomainError(result.error.code, result.error.message, result.error.details ?? {});
    }
    return result.data;
  }
}
