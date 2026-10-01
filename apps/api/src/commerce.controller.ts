import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res } from '@nestjs/common';
import {
  createActionRequest,
  decideApproval,
  executeUpdateOrder,
  getOrder,
  getShippingStatus,
  listAnomalies,
  listTickets,
  recordConsent,
  ticketConsentPayload,
  DomainError,
} from '@commerce/domain';
import { invokeTool } from '@commerce/tools';
import type { Request, Response } from 'express';
import { DOMAIN, DomainService } from './domain.service.js';

@Controller('v1')
export class CommerceController {
  constructor(@Inject(DOMAIN) private readonly domain: DomainService) {}

  @Get('orders/:id')
  async order(@Req() req: Request, @Param('id') id: string) {
    const ctx = await this.domain.actorOf(req);
    const order = await getOrder(this.domain.requireDb(), ctx, id);
    return {
      id: order.id,
      customer_id: order.customerId,
      status: order.status,
      currency: order.currency,
      total_minor: order.totalMinor,
      version: order.version,
      items: order.items.map((item) => ({
        id: item.id,
        sku_id: item.skuId,
        quantity: item.quantity,
        unit_price_minor: item.unitPriceMinor,
        title_snapshot: item.titleSnapshot,
      })),
      observed_at: new Date().toISOString(),
      source: 'sql',
    };
  }

  @Get('orders/:id/shipping')
  async shipping(@Req() req: Request, @Param('id') id: string) {
    const ctx = await this.domain.actorOf(req);
    const shipping = await getShippingStatus(this.domain.requireDb(), ctx, id);
    return {
      order_id: shipping.orderId,
      order_status: shipping.orderStatus,
      shipments: shipping.shipments.map((s) => ({
        id: s.id,
        status: s.status,
        tracking_ref: s.trackingRef,
        stale: s.stale,
        source_mode: s.sourceMode,
        last_observed_at: s.lastObservedAt,
        items: s.items.map((item) => ({
          order_item_id: item.orderItemId,
          quantity: item.quantity,
        })),
      })),
      observed_at: shipping.observedAt,
      source: 'sql',
    };
  }

  @Get('anomalies')
  async anomalies(@Req() req: Request) {
    const ctx = await this.domain.actorOf(req);
    return { items: await listAnomalies(this.domain.requireDb(), ctx), source: 'sql' };
  }

  @Get('support-tickets')
  async tickets(@Req() req: Request) {
    const ctx = await this.domain.actorOf(req);
    return { items: await listTickets(this.domain.requireDb(), ctx) };
  }

  /**
   * The user's explicit confirmation of one exact ticket payload, recorded from the authenticated
   * console event. Agents and MCP clients cannot reach this endpoint with an MCP token.
   */
  @Post('consents')
  async consent(
    @Req() req: Request,
    @Body()
    body: {
      command?: unknown;
      payload?: {
        order_id?: string;
        category?: string;
        summary?: string;
        evidence_refs?: { kind: string; id: string }[];
      };
    },
  ) {
    const ctx = await this.domain.actorOf(req);
    if (body.command !== 'create_support_ticket' || typeof body.payload !== 'object') {
      throw new DomainError('VALIDATION_ERROR', 'command and payload are required');
    }
    const consent = await recordConsent(this.domain.requireDb(), ctx, {
      command: 'create_support_ticket',
      payload: ticketConsentPayload({
        orderId: body.payload.order_id,
        category: body.payload.category ?? '',
        summary: (body.payload.summary ?? '').trim(),
        evidenceRefs: body.payload.evidence_refs,
      }),
    });
    return { id: consent.id, command: consent.command, expires_at: consent.expiresAt };
  }

  @Post('support-tickets')
  async createTicket(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    const ctx = await this.domain.actorOf(req);
    // Same schema, scopes, consent and audit path as the MCP tool.
    const result = await invokeTool(this.domain.requireDb(), ctx, {
      name: 'create_support_ticket',
      args: { ...body, idempotency_key: idempotencyKey ?? '' },
    });
    if (!result.ok) {
      throw new DomainError(result.error.code, result.error.message, result.error.details ?? {});
    }
    res.status(201);
    return result.data;
  }
  @Post('action-requests')
  async actionRequest(
    @Req() req: Request,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body()
    body: {
      resource_id: string;
      expected_version: number;
      run_id?: string;
    },
  ) {
    const ctx = await this.domain.actorOf(req);
    return createActionRequest(this.domain.requireDb(), ctx, {
      tool: 'update_order',
      resourceId: body.resource_id,
      canonicalArgs: { action: 'request_cancellation', expectedVersion: body.expected_version },
      runId: body.run_id,
      idempotencyKey: idempotencyKey ?? 'missing',
    });
  }

  @Post('approvals/:id/decision')
  async decision(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { decision: 'APPROVED' | 'REJECTED'; reason?: string },
  ) {
    const ctx = await this.domain.actorOf(req);
    return decideApproval(this.domain.requireDb(), ctx, {
      actionRequestId: id,
      decision: body.decision,
      reason: body.reason,
    });
  }

  @Post('orders/:id/actions')
  async orderAction(
    @Req() req: Request,
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body()
    body: { action: 'request_cancellation'; expected_version: number; action_request_id: string },
  ) {
    const ctx = await this.domain.actorOf(req);
    return executeUpdateOrder(this.domain.requireDb(), ctx, {
      orderId: id,
      action: body.action,
      expectedVersion: body.expected_version,
      actionRequestId: body.action_request_id,
      idempotencyKey: idempotencyKey ?? 'missing',
    });
  }
}
