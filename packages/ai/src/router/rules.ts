import type { Slots } from './slots.js';

export const INTENTS = [
  'order_investigation',
  'product_recommendation',
  'inventory_anomaly',
  'out_of_scope',
] as const;
export type Intent = (typeof INTENTS)[number];

/**
 * Requests the MVP refuses with a limitation instead of routing: price or stock changes, refunds,
 * profile changes, approval by the agent and instructions to drop its rules (non-goals in
 * docs/mvp-scope.md and agent boundaries in docs/agents-security-mcp.md).
 */
const OUT_OF_SCOPE: readonly RegExp[] = [
  /\b(ignora|olvida|omite)\b.*\b(instrucciones|reglas|restricciones)\b/,
  /\bact[uú]a como\b/,
  /\baprueba\b/,
  /\b(cambia|pon|ajusta|modifica)\b.*\b(precio|gratis|stock)\b/,
  /\breembolso\b|\bdevu[eé]lv[ae]n?(me)? el dinero\b/,
  /\b(cambia|actualiza|modifica)\b.*\b(direcci[oó]n|email|correo|tel[eé]fono)\b/,
  /\btodos los clientes\b/,
];

const ORDER: readonly RegExp[] = [
  /\b(pedido|orden|compra|paquete|env[ií]o|tracking|seguimiento|transportista|entrega(do)?|caja)s?\b/,
];
const RECOMMENDATION: readonly RegExp[] = [
  /\b(recomi[eé]nd|recomend|sugi[eé]r|conviene|busco|necesito|quiero)\w*\b.*\b(notebook|laptop|port[aá]til|computadora|equipo|m[aá]quina|mouse|rat[oó]n|accesorio)s?\b/,
  /\b(notebook|laptop|port[aá]til|computadora|equipo|m[aá]quina|mouse|rat[oó]n)s?\b.*\b(para|con|de)\b.*\b(desarrollo|programar|compilar|docker|virtuales|ram|memoria|\d+\s*gb)\b/,
  /\b(compara|conviene m[aá]s)\b/,
  /\bqu[eé] (laptop|notebook|port[aá]til|computadora|rat[oó]n|mouse)\b/,
];
const INVENTORY: readonly RegExp[] = [
  /\b(stock|inventario|quiebre|cobertura|discrepancia|conteo|alerta)s?\b/,
  /\bnos quedamos sin\b/,
  /\b(pedido|orden) inusual\b/,
];

export interface RuleMatch {
  readonly intents: readonly Intent[];
  /** Rules matched at least one intent; otherwise the bounded classifier decides. */
  readonly matched: boolean;
}

/** Explicit, auditable rules; they resolve before any statistical classifier is consulted. */
export function matchRules(message: string, slots: Slots): RuleMatch {
  const text = message.toLowerCase();
  if (OUT_OF_SCOPE.some((r) => r.test(text))) {
    return { intents: ['out_of_scope'], matched: true };
  }
  const intents = new Set<Intent>();
  if (INVENTORY.some((r) => r.test(text))) intents.add('inventory_anomaly');
  const recommendation = RECOMMENDATION.some((r) => r.test(text)) || slots.budget !== undefined;
  if (recommendation) intents.add('product_recommendation');
  // "pedido inusual" is an inventory alert, not a customer order question.
  const orderWords = ORDER.some((r) => r.test(text)) && !/\b(pedido|orden) inusual\b/.test(text);
  if (
    slots.orderIds.length > 0 ||
    (orderWords && !recommendation && !intents.has('inventory_anomaly'))
  ) {
    intents.add('order_investigation');
  }
  return { intents: [...intents].sort(), matched: intents.size > 0 };
}
