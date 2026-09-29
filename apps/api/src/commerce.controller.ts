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
  checkInventory,
  createActionRequest,
  createAgentRun,
  createSupportTicket,
  decideApproval,
  executeUpdateOrder,
  getAgentRun,
  getOrder,
  getProduct,
  getShippingStatus,
  listAnomalies,
  listCatalog,
  listTickets,
} from '@commerce/domain';
import { classifyIntent, runSpecialist } from '@commerce/ai';
import type { Request, Response } from 'express';
import { DOMAIN, DomainService } from './domain.service.js';

@Controller('v1')
export class CommerceController {
  constructor(@Inject(DOMAIN) private readonly domain: DomainService) {}

  @Get('products')
  async products(
    @Req() req: Request,
    @Query('category') category?: string,
    @Query('currency') currency?: string,
    @Query('price_lt') priceLt?: string,
    @Query('ram_gb') ramGb?: string,
    @Query('region') region?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const ctx = await this.domain.actorOf(req);
    const page = await listCatalog(this.domain.requireDb(), ctx, {
      category,
      currency,
      priceLt: priceLt === undefined ? undefined : Number(priceLt),
      ramGb: ramGb === undefined ? undefined : Number(ramGb),
      region,
      cursor,
      limit: limit === undefined ? undefined : Number(limit),
    });
    return {
      items: page.items.map((sku) => ({
        id: sku.id,
        product_id: sku.productId,
        sku_code: sku.skuCode,
        title: sku.title,
        category: sku.category,
        price_minor: sku.priceMinor,
        currency: sku.currency,
        ram_gb: sku.ramGb,
        cpu_family: sku.cpuFamily,
        available: sku.available,
        region: sku.region,
        observed_at: sku.observedAt,
      })),
      next_cursor: page.nextCursor,
      observed_at: page.observedAt,
      source: 'sql',
      version: 'catalog.v1',
    };
  }

  @Get('products/:id')
  async product(@Req() req: Request, @Param('id') id: string, @Query('region') region?: string) {
    const ctx = await this.domain.actorOf(req);
    const product = await getProduct(this.domain.requireDb(), ctx, id, region);
    const observedAt = new Date().toISOString();
    return {
      items: product.skus.map((sku) => ({
        id: sku.id,
        product_id: sku.productId,
        sku_code: sku.skuCode,
        title: sku.title,
        category: sku.category,
        price_minor: sku.priceMinor,
        currency: sku.currency,
        ram_gb: sku.ramGb,
        cpu_family: sku.cpuFamily,
        available: sku.available,
        region: sku.region,
        observed_at: sku.observedAt,
      })),
      next_cursor: null,
      observed_at: observedAt,
      source: 'sql',
      version: 'catalog.v1',
    };
  }

  @Get('inventory/:sku')
  async inventory(
    @Req() req: Request,
    @Param('sku') sku: string,
    @Query('region') region?: string,
  ) {
    const ctx = await this.domain.actorOf(req);
    const row = await checkInventory(this.domain.requireDb(), ctx, sku, region);
    return {
      sku_id: row.skuId,
      available: row.available,
      on_hand: row.onHand,
      reserved: row.reserved,
      safety_stock: row.safetyStock,
      region: row.region,
      observed_at: row.observedAt,
      source: 'sql',
    };
  }

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

  @Post('support-tickets')
  async createTicket(
    @Req() req: Request,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body()
    body: {
      customer_id: string;
      order_id?: string;
      category: string;
      summary: string;
      confirmed: boolean;
    },
  ) {
    const ctx = await this.domain.actorOf(req);
    return createSupportTicket(this.domain.requireDb(), ctx, {
      customerId: body.customer_id,
      orderId: body.order_id,
      category: body.category,
      summary: body.summary,
      confirmed: body.confirmed,
      idempotencyKey: idempotencyKey ?? 'missing',
    });
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

  @Post('agent-runs')
  async createRun(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() body: { message: string },
  ) {
    const ctx = await this.domain.actorOf(req);
    const classified = classifyIntent(body.message);
    const run = await createAgentRun(this.domain.requireDb(), ctx, {
      intent: classified.intent,
      promptVersion: 'router.v1',
      modelVersion: 'simulated-llm.v1',
    });
    if (classified.intent !== 'clarify') {
      await runSpecialist(this.domain.requireDb(), ctx, run.id, classified.intent, body.message);
    }
    res.status(202);
    return {
      id: run.id,
      status: run.status,
      intent: classified.intent,
      observed_at: new Date().toISOString(),
    };
  }

  @Get('agent-runs/:id')
  async run(@Req() req: Request, @Param('id') id: string) {
    const ctx = await this.domain.actorOf(req);
    const run = await getAgentRun(this.domain.requireDb(), ctx, id);
    return {
      id: run.id,
      status: run.status,
      intent: run.intent,
      observed_at: new Date().toISOString(),
    };
  }

  @Get('agent-runs/:id/events')
  async events(@Req() req: Request, @Res() res: Response, @Param('id') id: string) {
    const ctx = await this.domain.actorOf(req);
    const run = await getAgentRun(this.domain.requireDb(), ctx, id);
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    for (const event of run.events) {
      res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event.data)}\n\n`);
    }
    res.end();
  }
}
