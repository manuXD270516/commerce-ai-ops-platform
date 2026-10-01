import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res } from '@nestjs/common';
import {
  getOrder,
  getShippingStatus,
  listAnomalies,
  listOrders,
  listTickets,
  recordConsent,
  ticketConsentPayload,
  DomainError,
} from '@commerce/domain';
import { invokeTool } from '@commerce/tools';
import type { Request, Response } from 'express';
import { DOMAIN, DomainService } from './domain.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('v1')
export class CommerceController {
  constructor(@Inject(DOMAIN) private readonly domain: DomainService) {}

  @Get('orders')
  async orders(@Req() req: Request) {
    const ctx = await this.domain.actorOf(req);
    const items = await listOrders(this.domain.requireDb(), ctx);
    return {
      items: items.map((o) => ({
        id: o.id,
        status: o.status,
        total_minor: o.totalMinor,
        version: o.version,
        created_at: o.createdAt,
      })),
      observed_at: new Date().toISOString(),
      source: 'sql',
    };
  }

  @Get('orders/:id')
  async order(@Req() req: Request, @Param('id') id: string) {
    const ctx = await this.domain.actorOf(req);
    if (!UUID.test(id)) throw new DomainError('NOT_FOUND', 'Order not found');
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
    if (!UUID.test(id)) throw new DomainError('NOT_FOUND', 'Order not found');
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
        estimated_delivery_at: s.estimatedDeliveryAt,
        delay_hours: s.delayHours,
        items: s.items.map((item) => ({
          order_item_id: item.orderItemId,
          quantity: item.quantity,
        })),
      })),
      escalation: {
        required: shipping.escalation.required,
        rule_version: shipping.escalation.ruleVersion,
        reasons: shipping.escalation.reasons,
      },
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
}
