import { randomUUID } from 'node:crypto';
import {
  TOOL_CLASSIFICATION,
  TOOL_NAMES,
  isToolName,
  loadToolInputSchema,
  type ToolClassification,
  type ToolName,
} from '@commerce/contracts';
import {
  DomainError,
  appendAudit,
  checkInventory,
  createSupportTicket,
  executeUpdateOrder,
  getCustomer,
  getOrder,
  getProduct,
  getShippingStatus,
  isDomainError,
  listCatalog,
  withUnitOfWork,
  type ActorContext,
  type DomainDb,
  type ErrorCode,
  type TicketCategory,
} from '@commerce/domain';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { effectiveScopes, toolAllowed, type Scope } from './scopes.js';

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

export interface ToolDefinition {
  readonly name: ToolName;
  readonly classification: ToolClassification;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = TOOL_NAMES.map((name) => {
  const schema = loadToolInputSchema(name);
  return {
    name,
    classification: TOOL_CLASSIFICATION[name],
    description: `${TOOL_CLASSIFICATION[name]}: ${typeof schema.description === 'string' ? schema.description : name}`,
    inputSchema: schema,
  };
});

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validators = new Map<ToolName, ValidateFunction>(
  TOOL_DEFINITIONS.map((tool) => [tool.name, ajv.compile(tool.inputSchema)]),
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Maximum serialized argument size; larger calls are rejected before any parsing work. */
export const MAX_ARGUMENT_BYTES = 16 * 1024;

export interface ToolCall {
  readonly name: string;
  readonly args: unknown;
  /** Scopes granted to the calling client (token `scope`); undefined = no client restriction. */
  readonly clientScopes?: readonly string[];
  /** Scopes of the specialist profile making the call; undefined = not an agent call. */
  readonly profileScopes?: readonly string[];
  readonly toolCallId?: string;
}

export interface ToolMeta {
  readonly tool: string;
  readonly classification: ToolClassification | 'UNKNOWN';
  readonly toolCallId: string;
  readonly observedAt: string;
}

export type ToolResult =
  | { readonly ok: true; readonly data: unknown; readonly meta: ToolMeta }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: ErrorCode;
        readonly message: string;
        readonly details?: Record<string, unknown>;
      };
      readonly meta: ToolMeta;
    };

/**
 * Single enforcement point shared by the MCP server and in-process agent calls: schema validation,
 * scope intersection, then the domain command, which re-checks tenant, ownership, consent and
 * approval itself. Annotations or model text never reach any of these decisions.
 */
export async function invokeTool(
  db: DomainDb,
  ctx: ActorContext,
  call: ToolCall,
): Promise<ToolResult> {
  const toolCallId =
    call.toolCallId !== undefined && UUID.test(call.toolCallId) ? call.toolCallId : randomUUID();
  const name = isToolName(call.name) ? call.name : undefined;
  const meta = (): ToolMeta => ({
    tool: call.name,
    classification: name ? TOOL_CLASSIFICATION[name] : 'UNKNOWN',
    toolCallId,
    observedAt: new Date().toISOString(),
  });
  try {
    if (!name) throw new DomainError('VALIDATION_ERROR', 'Unknown tool');
    if (Buffer.byteLength(JSON.stringify(call.args ?? null)) > MAX_ARGUMENT_BYTES) {
      throw new DomainError('VALIDATION_ERROR', 'Arguments exceed the size limit');
    }
    const validate = validators.get(name);
    if (!validate?.(call.args)) {
      throw new DomainError('VALIDATION_ERROR', 'Arguments do not match the tool schema', {
        errors: (validate?.errors ?? []).slice(0, 5).map((e) => ({
          path: e.instancePath || '/',
          keyword: e.keyword,
          ...(e.keyword === 'additionalProperties'
            ? { property: (e.params as { additionalProperty: string }).additionalProperty }
            : {}),
        })),
      });
    }
    const scopes = effectiveScopes(ctx.role, call.clientScopes, call.profileScopes);
    if (!toolAllowed(name, scopes)) {
      throw new DomainError('FORBIDDEN', 'Tool not within the effective scopes');
    }
    const data = await execute(db, ctx, name, call.args as Record<string, unknown>, scopes);
    await auditCall(db, ctx, name, toolCallId, 'ALLOWED');
    return { ok: true, data, meta: meta() };
  } catch (error) {
    const mapped = isDomainError(error)
      ? error
      : new DomainError('DEPENDENCY_UNAVAILABLE', 'Tool execution failed');
    const outcome = isDomainError(error) ? 'DENIED' : 'ERROR';
    await auditCall(db, ctx, call.name, toolCallId, outcome).catch(() => undefined);
    return {
      ok: false,
      error: {
        code: mapped.code,
        message: mapped.message,
        ...(Object.keys(mapped.details).length > 0 ? { details: mapped.details } : {}),
      },
      meta: meta(),
    };
  }
}

async function auditCall(
  db: DomainDb,
  ctx: ActorContext,
  tool: string,
  toolCallId: string,
  outcome: 'ALLOWED' | 'DENIED' | 'ERROR',
): Promise<void> {
  await withUnitOfWork(db, ctx, (trx) =>
    appendAudit(trx, ctx, {
      action: `tool.${isToolName(tool) ? tool : 'unknown'}`,
      resourceType: 'tool_call',
      resourceId: toolCallId,
      outcome,
    }),
  );
}

async function execute(
  db: DomainDb,
  ctx: ActorContext,
  name: ToolName,
  args: Record<string, unknown>,
  scopes: readonly Scope[],
): Promise<unknown> {
  const str = (key: string) => args[key] as string | undefined;
  const num = (key: string) => args[key] as number | undefined;
  switch (name) {
    case 'search_products': {
      const lte = num('price_lte_minor');
      const page = await listCatalog(db, ctx, {
        text: str('query'),
        category: str('category'),
        currency: str('currency'),
        priceLt: num('price_lt_minor') ?? (lte === undefined ? undefined : lte + 1),
        ramGb: num('ram_gb'),
        cpuFamily: str('cpu_family'),
        region: str('region'),
        inStock: args.in_stock as boolean | undefined,
        cursor: str('cursor'),
        limit: num('limit'),
      });
      return {
        items: page.items.map(skuView),
        next_cursor: page.nextCursor,
        observed_at: page.observedAt,
        source: 'sql',
      };
    }
    case 'get_product': {
      const skuId = str('sku_id');
      let productId = str('product_id');
      if (skuId) {
        const page = await listCatalog(db, ctx, { skuId, limit: 1 });
        productId = page.items[0]?.productId;
        if (!productId) throw new DomainError('NOT_FOUND', 'Product not found');
      }
      const product = await getProduct(db, ctx, productId ?? '', str('region'));
      return {
        product_id: product.productId,
        title: product.title,
        category: product.category,
        skus: product.skus.map(skuView),
        source: 'sql',
      };
    }
    case 'check_inventory': {
      const items = [];
      for (const skuId of args.sku_ids as string[]) {
        const view = await checkInventory(db, ctx, skuId, str('region'));
        items.push({
          sku_id: view.skuId,
          region: view.region,
          available: view.available,
          in_stock: view.available > 0,
          observed_at: view.observedAt,
          ...(view.detail
            ? {
                on_hand: view.detail.onHand,
                reserved: view.detail.reserved,
                safety_stock: view.detail.safetyStock,
              }
            : {}),
        });
      }
      return { items, source: 'sql' };
    }
    case 'get_order': {
      const order = await getOrder(db, ctx, str('order_id') ?? '');
      return {
        id: order.id,
        customer_id: order.customerId,
        status: order.status,
        currency: order.currency,
        total_minor: order.totalMinor,
        version: order.version,
        items: order.items.map((i) => ({
          id: i.id,
          sku_id: i.skuId,
          quantity: i.quantity,
          unit_price_minor: i.unitPriceMinor,
          title_snapshot: i.titleSnapshot,
        })),
        observed_at: new Date().toISOString(),
        source: 'sql',
      };
    }
    case 'get_customer': {
      const customerId = str('customer_id') ?? '';
      // customers:read:self only reaches the caller's own record, even for non-customer roles.
      if (!scopes.includes('customers:read:support') && customerId !== ctx.customerId) {
        throw new DomainError('NOT_FOUND', 'Customer not found');
      }
      const customer = await getCustomer(db, ctx, customerId);
      // Minimal profile by design: no address, no email, no order history.
      return {
        id: customer.id,
        display_name: customer.displayName,
        observed_at: customer.observedAt,
        source: 'sql',
      };
    }
    case 'get_shipping_status': {
      const status = await getShippingStatus(db, ctx, str('order_id') ?? '');
      const shipmentId = str('shipment_id');
      const shipments = shipmentId
        ? status.shipments.filter((s) => s.id === shipmentId)
        : status.shipments;
      if (shipmentId && shipments.length === 0) {
        throw new DomainError('NOT_FOUND', 'Shipment not found for this order');
      }
      return {
        order_id: status.orderId,
        order_status: status.orderStatus,
        shipments: shipments.map((s) => ({
          id: s.id,
          status: s.status,
          tracking_ref: s.trackingRef,
          stale: s.stale,
          source_mode: s.sourceMode,
          last_observed_at: s.lastObservedAt,
          estimated_delivery_at: s.estimatedDeliveryAt,
          delay_hours: s.delayHours,
          items: s.items.map((i) => ({ order_item_id: i.orderItemId, quantity: i.quantity })),
        })),
        escalation: {
          required: status.escalation.required,
          rule_version: status.escalation.ruleVersion,
          reasons: status.escalation.reasons,
        },
        observed_at: status.observedAt,
        source: 'sql',
      };
    }
    case 'create_support_ticket': {
      const ticket = await createSupportTicket(db, ctx, {
        orderId: str('order_id'),
        category: str('category') as TicketCategory,
        summary: str('summary') ?? '',
        evidenceRefs: (args.evidence_refs ?? []) as { kind: 'order'; id: string }[],
        consentId: str('consent_id') ?? '',
        idempotencyKey: str('idempotency_key') ?? '',
      });
      return {
        id: ticket.id,
        order_id: ticket.orderId,
        category: ticket.category,
        status: ticket.status,
        source: 'sql',
      };
    }
    case 'update_order': {
      const result = await executeUpdateOrder(db, ctx, {
        orderId: str('order_id') ?? '',
        action: 'request_cancellation',
        reasonCode: str('reason_code') ?? '',
        expectedVersion: num('expected_version') ?? 0,
        actionRequestId: str('action_request_id') ?? '',
        idempotencyKey: str('idempotency_key') ?? '',
      });
      return {
        order_id: result.orderId,
        status: result.status,
        version: result.version,
        source: 'sql',
      };
    }
  }
}

function skuView(sku: {
  id: string;
  productId: string;
  skuCode: string;
  title: string;
  priceMinor: number;
  currency: string;
  ramGb: number | null;
  cpuFamily: string | null;
  available: number;
  region: string;
  observedAt: string;
}) {
  return {
    sku_id: sku.id,
    product_id: sku.productId,
    sku_code: sku.skuCode,
    title: sku.title,
    price_minor: sku.priceMinor,
    currency: sku.currency,
    ram_gb: sku.ramGb,
    cpu_family: sku.cpuFamily,
    available: sku.available,
    region: sku.region,
    observed_at: sku.observedAt,
  };
}
