import type { ActorContext, DomainDb } from '@commerce/domain';
import {
  DEFAULT_BUDGETS,
  appendRunEvent,
  checkInventory,
  consumeBudget,
  getAgentRun,
  getOrder,
  getShippingStatus,
  latestCheckpoint,
  listAnomalies,
  listCatalog,
  retrieve,
  saveCheckpoint,
  selectPolicyForOrder,
} from '@commerce/domain';

export const PROVIDER_MODES = ['real', 'simulated'] as const;
export type ProviderMode = (typeof PROVIDER_MODES)[number];

export const SELECTED_PROVIDER = {
  id: 'simulated-llm',
  model: 'simulated-llm.v1',
  promptVersion: 'router.v1',
  embeddings: 'local-hash-v1',
  mode: 'simulated' as const,
};

export type Intent = 'order' | 'recommendation' | 'inventory' | 'clarify';

export function classifyIntent(message: string): { intent: Intent; slots: Record<string, string> } {
  const text = message.toLowerCase();
  const slots: Record<string, string> = {};
  const orderIds =
    message.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
  if (orderIds[0]) slots.orderId = orderIds[0];
  if (orderIds.length > 1) return { intent: 'clarify', slots };
  if (/(atraso|env[ií]o|orden|pedido|lost|perdid)/i.test(text) && slots.orderId) {
    return { intent: 'order', slots };
  }
  if (/(notebook|recomienda|presupuesto|menos de|usd)/i.test(text)) {
    return { intent: 'recommendation', slots };
  }
  if (/(stock|inventario|alerta|discrepan)/i.test(text)) {
    return { intent: 'inventory', slots };
  }
  if (/(atraso|orden|pedido)/i.test(text) && !slots.orderId) {
    return { intent: 'clarify', slots };
  }
  return { intent: 'clarify', slots };
}

export function simulateLlm(input: { intent: Intent; evidence: unknown }): {
  text: string;
  tokens: number;
} {
  const text = JSON.stringify({ intent: input.intent, evidence: input.evidence }).slice(0, 1500);
  return { text, tokens: Math.ceil(text.length / 4) };
}

export async function runSpecialist(
  db: DomainDb,
  ctx: ActorContext,
  runId: string,
  intent: Intent,
  message: string,
): Promise<{ status: string; summary: string }> {
  const used = { llmCalls: 0, toolCalls: 0, tokens: 0, startedAt: Date.now() };
  const checkpoint = await latestCheckpoint(db, ctx, runId);
  if (typeof checkpoint === 'object' && checkpoint !== null && 'status' in checkpoint) {
    const previous = checkpoint as { status: string; summary: string };
    if (previous.status === 'COMPLETED' || previous.status === 'WAITING_HUMAN') return previous;
  }

  try {
    used.toolCalls += 1;
    consumeBudget(used);
    let summary: string;
    if (intent === 'order') {
      summary = await investigateOrder(db, ctx, message);
    } else if (intent === 'recommendation') {
      summary = await recommend(db, ctx, message);
    } else if (intent === 'inventory') {
      summary = await explainInventory(db, ctx);
    } else {
      summary = 'Necesito el identificador de la orden o más detalle. No invento un order_id.';
    }
    used.llmCalls += 1;
    const llm = simulateLlm({ intent, evidence: summary });
    used.tokens += llm.tokens;
    consumeBudget(used);
    await appendRunEvent(db, ctx, runId, {
      type: 'completed',
      intent,
      summary,
      provider: SELECTED_PROVIDER,
    });
    await saveCheckpoint(db, ctx, runId, { status: 'COMPLETED', summary }, 'COMPLETED');
    return { status: 'COMPLETED', summary };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'failed';
    await saveCheckpoint(db, ctx, runId, { status: 'FAILED', summary: messageText }, 'FAILED');
    const run = await getAgentRun(db, ctx, runId);
    return { status: run.status, summary: messageText };
  }
}

async function investigateOrder(db: DomainDb, ctx: ActorContext, message: string): Promise<string> {
  const classified = classifyIntent(message);
  const orderId = classified.slots.orderId;
  if (!orderId) return 'Aclaración: indique un order_id propio.';
  const order = await getOrder(db, ctx, orderId);
  const shipping = await getShippingStatus(db, ctx, orderId);
  let policyNote = 'sin política aplicable';
  try {
    const policy = await selectPolicyForOrder(db, ctx, {
      kind: 'shipping',
      purchasedAt: new Date(order.items.length ? '2026-09-01T00:00:00.000Z' : Date.now()),
      region: 'us-east',
    });
    if (policy) policyNote = `${policy.citation.sourceUri} v${policy.citation.version}`;
  } catch {
    policyNote = 'incertidumbre: fuentes contradictorias; me abstengo de afirmar una obligación';
  }
  const lost = shipping.shipments.some((s) => s.status === 'LOST');
  const disputed = shipping.shipments.some((s) => s.status === 'DELIVERED_DISPUTED');
  const stale = shipping.shipments.filter((s) => s.stale);
  const delayed = shipping.shipments.filter((s) => s.status === 'DELAYED' || s.stale);
  const escalate =
    disputed ||
    delayed.some((s) => Date.now() - new Date(s.lastObservedAt).getTime() > 48 * 3600 * 1000);
  const facts = [
    `orden ${order.id} estado ${order.status} (hecho)`,
    `paquetes: ${shipping.shipments.map((s) => `${s.trackingRef}=${s.status}`).join(', ')}`,
    lost
      ? 'estado logístico LOST; recomiendo escalar, sin atribuir causa no registrada'
      : undefined,
    stale.length
      ? `tracking stale (${stale.map((s) => s.lastObservedAt).join(', ')}); no confirmo fecha de entrega`
      : undefined,
    escalate ? 'umbral de escalamiento 48h / DELIVERED_DISPUTED alcanzado' : undefined,
    `política ${policyNote}`,
    'no se crea ticket sin consentimiento explícito',
  ];
  return facts.filter(Boolean).join('. ');
}

async function recommend(db: DomainDb, ctx: ActorContext, message: string): Promise<string> {
  const budget = /1500|1\.500|150000/.test(message) ? 150_000 : undefined;
  const page = await listCatalog(db, ctx, {
    category: 'notebook',
    currency: 'USD',
    priceLt: budget,
    region: 'us-east',
    limit: 3,
  });
  const eligible = [];
  for (const sku of page.items) {
    const stock = await checkInventory(db, ctx, sku.id, 'us-east');
    if (stock.available <= 0) continue;
    const docs = await retrieve(db, ctx, {
      query: sku.title,
      kind: 'product',
      productId: sku.productId,
    });
    eligible.push({
      sku: sku.skuCode,
      priceMinor: sku.priceMinor,
      available: stock.available,
      citation: docs[0]?.citation.sourceUri ?? 'sql',
    });
  }
  if (eligible.length === 0) {
    return 'No hay candidatos que cumplan presupuesto y atributos; no relajo restricciones.';
  }
  return `Hasta tres opciones elegibles: ${JSON.stringify(eligible.slice(0, 3))}. Recomendación, no reserva.`;
}

async function explainInventory(db: DomainDb, ctx: ActorContext): Promise<string> {
  const anomalies = await listAnomalies(db, ctx);
  return `Alertas (el agente no ajusta inventario): ${JSON.stringify(
    anomalies.map((a) => ({ rule: a.ruleId, version: a.ruleVersion, status: a.status })),
  )}. Presupuesto de run ${DEFAULT_BUDGETS.tokens} tokens.`;
}

export { DEFAULT_BUDGETS };
