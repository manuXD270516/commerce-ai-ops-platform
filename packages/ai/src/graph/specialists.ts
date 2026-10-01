import {
  listAnomalies,
  searchKnowledge,
  selectApplicablePolicy,
  isDomainError,
  type ActorContext,
  type DomainDb,
  type Embedder,
} from '@commerce/domain';
import type { Slots } from '../router/index.js';
import type { EvidenceItem, ToolGateway } from './gateway.js';
import type {
  AlertExplanation,
  CancellationProposal,
  Fact,
  RecommendationItem,
  SpecialistFinding,
} from './types.js';

export interface SpecialistDeps {
  readonly db: DomainDb;
  readonly ctx: ActorContext;
  readonly gateway: ToolGateway;
  readonly embedder: Embedder;
  /** Logistic region of the MVP (single region, docs/mvp-scope.md). */
  readonly region: string;
  readonly locale: string;
}

const sql = (kind: string, ref: string, version: string, observedAt: string): EvidenceItem => ({
  kind,
  ref,
  version,
  observedAt,
  source: 'sql',
});

interface OrderData {
  id: string;
  status: string;
  version: number;
  items: { id: string; quantity: number; title_snapshot: string }[];
  observed_at: string;
}

interface ShippingData {
  shipments: {
    id: string;
    status: string;
    tracking_ref: string;
    stale: boolean;
    source_mode: string;
    last_observed_at: string;
    estimated_delivery_at: string | null;
    delay_hours: number | null;
    items: { order_item_id: string; quantity: number }[];
  }[];
  escalation: { required: boolean; rule_version: string; reasons: string[] };
  observed_at: string;
}

const REASON_TEXT: Record<string, string> = {
  shipment_lost: 'un paquete figura como LOST',
  delivered_disputed: 'un paquete figura como entregado pero en disputa',
  delay_over_48h: 'un paquete supera 48 h de atraso sobre la fecha prometida',
};

/**
 * Order specialist with the Support step: reads order, every package and the policy in force at
 * purchase; reports facts, labelled inferences, uncertainty and the deterministic escalation rule.
 * It can only propose a ticket or a cancellation; creating either needs the user and, for
 * cancellation, an approver.
 */
export async function investigateOrder(
  deps: SpecialistDeps,
  slots: Slots,
): Promise<SpecialistFinding> {
  const orderId = slots.orderIds[0] ?? '';
  const order = await deps.gateway.call('order', 'get_order', { order_id: orderId });
  if (!order.ok) {
    // NOT_FOUND covers both "does not exist" and "not yours": nothing else is revealed.
    return {
      specialist: 'order',
      status: order.error.code === 'NOT_FOUND' ? 'not_found' : 'forbidden',
      facts: [],
      inferences: [],
      uncertainty: [],
      nextSteps: [
        'Verificá el número de orden; sólo puedo consultar órdenes a las que tenés acceso.',
      ],
    };
  }
  const o = order.data as OrderData;
  const facts: Fact[] = [
    {
      text: `La orden ${o.id} está en estado ${o.status} (versión ${String(o.version)}).`,
      evidence: sql('order', `order:${o.id}`, `v${String(o.version)}`, o.observed_at),
    },
  ];
  const inferences: string[] = [];
  const uncertainty: string[] = [];
  const nextSteps: string[] = [];
  let escalation: SpecialistFinding['escalation'];
  let status: SpecialistFinding['status'] = 'ok';

  const shipping = await deps.gateway.call('order', 'get_shipping_status', { order_id: o.id });
  let shipments: ShippingData['shipments'] = [];
  if (shipping.ok) {
    const s = shipping.data as ShippingData;
    shipments = s.shipments;
    if (shipments.length === 0) {
      facts.push({
        text: 'La orden todavía no tiene paquetes despachados.',
        evidence: sql('shipping', `order:${o.id}`, 'none', s.observed_at),
      });
    }
    for (const p of shipments) {
      const lines = p.items
        .map(
          (i) => o.items.find((it) => it.id === i.order_item_id)?.title_snapshot ?? i.order_item_id,
        )
        .join(', ');
      const promised = p.estimated_delivery_at
        ? `; fecha prometida ${p.estimated_delivery_at}`
        : '';
      const delay = p.delay_hours !== null ? `; ${String(p.delay_hours)} h de atraso` : '';
      facts.push({
        text: `Paquete ${p.tracking_ref} (${lines}): ${p.status}, observado ${p.last_observed_at}${promised}${delay}. Fuente: transportista simulado.`,
        evidence: sql('shipment', `shipment:${p.id}`, p.status, p.last_observed_at),
      });
      if (p.stale) {
        uncertainty.push(
          `El tracking de ${p.tracking_ref} no se actualiza desde ${p.last_observed_at} (más de 6 h): no puedo confirmar una fecha de entrega.`,
        );
      }
      if (p.status === 'LOST') {
        uncertainty.push(
          `El transportista marcó ${p.tracking_ref} como LOST; no hay una causa registrada y no la infiero.`,
        );
      }
    }
    if (shipments.length > 1) {
      inferences.push(
        `Inferencia: es un envío parcial (${String(shipments.length)} paquetes con estados distintos); el estado de la orden no implica que todo haya llegado.`,
      );
    }
    escalation = {
      required: s.escalation.required,
      ruleVersion: s.escalation.rule_version,
      reasons: s.escalation.reasons,
    };
    if (s.escalation.required) {
      nextSteps.push(
        `Corresponde escalar a soporte según la regla ${s.escalation.rule_version}: ${s.escalation.reasons
          .map((r) => REASON_TEXT[r] ?? r)
          .join('; ')}.`,
      );
    }
  } else {
    status = 'partial';
    uncertainty.push(
      `No pude obtener el estado logístico (${shipping.error.code}); no afirmo ninguna fecha de entrega.`,
    );
    nextSteps.push('Puedo ofrecerte soporte para revisar el envío.');
  }

  try {
    const policy = await deps.gateway.retrieval(() =>
      selectApplicablePolicy(deps.db, deps.ctx, {
        orderId: o.id,
        kind: 'shipping',
        region: deps.region,
        locale: deps.locale,
      }),
    );
    if (policy.status === 'APPLICABLE') {
      facts.push({
        text: `Política aplicable a la fecha de compra: "${policy.policy.title}" v${String(policy.policy.version)}, sección ${policy.policy.section || 'general'}.`,
        evidence: {
          kind: 'policy',
          ref: policy.policy.sourceUri,
          version: `v${String(policy.policy.version)}`,
          observedAt: policy.purchasedAt,
          source: 'knowledge',
          documentVersionId: policy.policy.documentVersionId,
        },
      });
    } else {
      uncertainty.push(
        policy.reason === 'CONFLICTING_POLICIES'
          ? 'Hay políticas de envío contradictorias vigentes para esta compra; me abstengo de afirmar una obligación.'
          : 'No encontré una política de envío aplicable a la fecha de compra; no afirmo plazos contractuales.',
      );
    }
  } catch (error) {
    if (!isDomainError(error)) throw error;
    uncertainty.push('No pude consultar la política aplicable.');
  }

  if (escalation?.required || shipments.some((p) => p.stale)) {
    nextSteps.push(
      'Si querés, puedo abrir un ticket de soporte con esta evidencia; sólo lo creo si lo confirmás.',
    );
  }

  let proposal: CancellationProposal | undefined;
  if (slots.action === 'request_cancellation') {
    const eligible = (o.status === 'PLACED' || o.status === 'CONFIRMED') && shipments.length === 0;
    proposal = {
      kind: 'update_order',
      orderId: o.id,
      action: 'request_cancellation',
      reasonCode: 'customer_request',
      expectedVersion: o.version,
      eligible,
      ...(eligible
        ? {}
        : {
            ineligibleReason: `la orden está en ${o.status} o ya tiene despacho; sólo se solicita en PLACED o CONFIRMED sin fulfillment`,
          }),
    };
    nextSteps.push(
      eligible
        ? 'Puedo preparar una solicitud de cancelación: requiere tu confirmación y la aprobación de otra persona, y sólo solicita la cancelación (no cancela ni reembolsa).'
        : 'No es posible solicitar la cancelación en este estado; puedo ofrecerte soporte.',
    );
  }

  return {
    specialist: 'order',
    status,
    facts,
    inferences,
    uncertainty,
    nextSteps,
    ...(escalation ? { escalation } : {}),
    ...(proposal ? { proposal } : {}),
  };
}

interface SkuData {
  sku_id: string;
  product_id: string;
  sku_code: string;
  title: string;
  price_minor: number;
  currency: string;
  ram_gb: number | null;
  available: number;
  region: string;
  observed_at: string;
}

const DEV_USE = /(desarrollo|programar|program|compil|docker|virtual|contenedor)/i;

/**
 * Recommendation specialist with the Catalog step: SQL eligibility through search_products,
 * semantic evidence from product documentation, soft preferences only as tie-breaks, and a final
 * stock revalidation through check_inventory right before answering.
 */
export async function recommendProductsForRun(
  deps: SpecialistDeps,
  message: string,
  slots: Slots,
): Promise<SpecialistFinding> {
  const filters: Record<string, unknown> = {
    currency: 'USD',
    in_stock: true,
    region: deps.region,
    limit: 50,
    ...(slots.category ? { category: slots.category } : { category: 'notebook' }),
    ...(slots.budget?.operator === 'lt' ? { price_lt_minor: slots.budget.minor } : {}),
    ...(slots.budget?.operator === 'lte' ? { price_lte_minor: slots.budget.minor } : {}),
    ...(slots.ramGb !== undefined ? { ram_gb: slots.ramGb } : {}),
  };
  const search = await deps.gateway.call('recommendation', 'search_products', filters);
  if (!search.ok) {
    return {
      specialist: 'recommendation',
      status: 'partial',
      facts: [],
      inferences: [],
      uncertainty: [`No pude consultar el catálogo (${search.error.code}).`],
      nextSteps: [],
    };
  }
  const candidates = (search.data as { items: SkuData[] }).items;
  const constraint = describeConstraints(filters);
  if (candidates.length === 0) {
    return {
      specialist: 'recommendation',
      status: 'no_candidates',
      facts: [],
      inferences: [],
      uncertainty: [],
      nextSteps: [
        `Ningún producto publicado con stock cumple ${constraint}. No relajo esas condiciones por mi cuenta: ¿querés cambiar presupuesto o atributos?`,
      ],
    };
  }

  const docs = await deps.gateway.retrieval(() =>
    searchKnowledge(deps.db, deps.ctx, deps.embedder, {
      query: message,
      kind: 'product',
      productIds: [...new Set(candidates.map((c) => c.product_id))],
    }),
  );
  // Documentation only ranks products SQL already admitted (search was limited to their ids).
  const productDocs = new Map<string, { score: number; evidence: EvidenceItem[] }>();
  for (const hit of docs.hits) {
    if (!hit.productId) continue;
    const entry = productDocs.get(hit.productId) ?? { score: 0, evidence: [] };
    entry.score = Math.max(entry.score, hit.score);
    if (!entry.evidence.some((e) => e.ref === hit.citation.sourceUri)) {
      entry.evidence.push({
        kind: 'product_doc',
        ref: hit.citation.sourceUri,
        version: `v${String(hit.citation.version)}`,
        observedAt: hit.citation.validFrom,
        source: 'knowledge',
        documentVersionId: hit.citation.documentVersionId,
      });
    }
    productDocs.set(hit.productId, entry);
  }
  const prefersPerformance = DEV_USE.test(message);
  const ranked = candidates
    .map((c) => {
      const doc = productDocs.get(c.product_id);
      const relevance = doc?.score ?? 0;
      return { c, relevance, evidence: doc?.evidence ?? [] };
    })
    .sort(
      (a, b) =>
        b.relevance - a.relevance ||
        (prefersPerformance ? (b.c.ram_gb ?? 0) - (a.c.ram_gb ?? 0) : 0) ||
        a.c.price_minor - b.c.price_minor ||
        a.c.sku_code.localeCompare(b.c.sku_code),
    );

  // Revalidate stock right before answering: a SKU that lost availability is dropped, not shown.
  const top = ranked.slice(0, 3);
  const check = await deps.gateway.call('recommendation', 'check_inventory', {
    sku_ids: top.map((t) => t.c.sku_id),
    region: deps.region,
  });
  const fresh = new Map<string, { available: number; observed_at: string }>();
  if (check.ok) {
    for (const i of (
      check.data as { items: { sku_id: string; available: number; observed_at: string }[] }
    ).items) {
      fresh.set(i.sku_id, i);
    }
  }
  const items: RecommendationItem[] = [];
  const dropped: string[] = [];
  for (const t of top) {
    const now = fresh.get(t.c.sku_id);
    if (!now || now.available <= 0) {
      dropped.push(t.c.sku_code);
      continue;
    }
    const reasons = [`cumple ${constraint}`];
    if (t.relevance > 0) reasons.push('su ficha coincide con lo que buscás');
    if (prefersPerformance && t.c.ram_gb)
      reasons.push(`${String(t.c.ram_gb)} GB de RAM para desarrollo (preferencia, no requisito)`);
    items.push({
      skuId: t.c.sku_id,
      skuCode: t.c.sku_code,
      title: t.c.title,
      priceMinor: t.c.price_minor,
      currency: t.c.currency,
      ramGb: t.c.ram_gb,
      available: now.available,
      observedAt: now.observed_at,
      justification: reasons.join('; '),
      evidence: [
        sql('sku', `sku:${t.c.sku_id}`, `price:${String(t.c.price_minor)}`, now.observed_at),
        ...t.evidence,
      ],
    });
  }
  const uncertainty: string[] = [];
  if (!check.ok)
    uncertainty.push(
      'No pude revalidar el stock; no muestro opciones sin disponibilidad confirmada.',
    );
  if (dropped.length > 0) {
    uncertainty.push(
      `${dropped.join(', ')} perdió disponibilidad mientras preparaba la respuesta y no se recomienda.`,
    );
  }
  return {
    specialist: 'recommendation',
    status: items.length > 0 ? 'ok' : 'no_candidates',
    facts: items.map((i) => ({
      text: `${i.skuCode} — ${i.title}: USD ${(i.priceMinor / 100).toFixed(2)}, ${String(i.available)} disponibles (observado ${i.observedAt}).`,
      evidence: i.evidence[0] ?? sql('sku', `sku:${i.skuId}`, 'unknown', i.observedAt),
    })),
    inferences: items.map((i) => `${i.skuCode}: ${i.justification}.`),
    uncertainty,
    nextSteps: [
      'Es una recomendación, no una reserva: precio y stock pueden cambiar hasta la compra.',
    ],
    items,
  };
}

function describeConstraints(filters: Record<string, unknown>): string {
  const parts = ['USD', `categoría ${String(filters.category)}`, 'stock disponible'];
  if (typeof filters.price_lt_minor === 'number')
    parts.push(`precio < USD ${(filters.price_lt_minor / 100).toFixed(2)}`);
  if (typeof filters.price_lte_minor === 'number')
    parts.push(`precio <= USD ${(filters.price_lte_minor / 100).toFixed(2)}`);
  if (typeof filters.ram_gb === 'number') parts.push(`${String(filters.ram_gb)} GB de RAM`);
  return parts.join(', ');
}

async function skuIdsByCode(deps: SpecialistDeps, codes: readonly string[]): Promise<Set<string>> {
  const ids = new Set<string>();
  const page = await deps.gateway.call('catalog', 'search_products', {
    currency: 'USD',
    limit: 50,
  });
  if (page.ok) {
    for (const s of (page.data as { items: { sku_id: string; sku_code: string }[] }).items) {
      if (codes.includes(s.sku_code)) ids.add(s.sku_id);
    }
  }
  return ids;
}

const RULE_TEXT: Record<string, (e: Record<string, unknown>) => string> = {
  critical_stock: (e) =>
    `disponible ${String(e.available)} <= stock de seguridad ${String(e.safety_stock)} (on_hand ${String(e.on_hand)}, reservado ${String(e.reserved)})`,
  discrepancy: (e) =>
    `el último conteo (${String(e.counted)}, ${String(e.counted_at)}) difiere del balance on_hand ${String(e.on_hand)}`,
  stockout_risk: (e) =>
    typeof e.reason === 'string'
      ? `datos insuficientes para estimar quiebre (${e.reason}: ${String(e.demand_days)} días con demanda, mínimo ${String(e.min_demand_days)})`
      : `cobertura ${String(e.cover_days)} días con demanda diaria ${String(e.daily_demand)}, menor al lead time de ${String(e.lead_time_days)} días`,
  unusual_order: (e) =>
    `cantidad ${String(e.quantity)} supera el umbral ${String(e.threshold)} = max(10, 3 × mediana ${String(e.median)}) con ${String(e.observations)} observaciones`,
};

/**
 * Inventory specialist: explains alerts produced by the deterministic detector, quoting the rule
 * id, version and the evidence the rule recorded, plus the current balance. It has no tool that
 * changes stock and does not compute anomalies itself.
 */
export async function explainInventory(
  deps: SpecialistDeps,
  slots: Slots,
): Promise<SpecialistFinding> {
  let anomalies;
  try {
    anomalies = await deps.gateway.retrieval(() => listAnomalies(deps.db, deps.ctx));
  } catch (error) {
    if (isDomainError(error) && error.code === 'FORBIDDEN') {
      return {
        specialist: 'inventory',
        status: 'forbidden',
        facts: [],
        inferences: [],
        uncertainty: [],
        nextSteps: [
          'Las alertas de inventario sólo están disponibles para operadores autorizados.',
        ],
      };
    }
    throw error;
  }
  // A named SKU narrows the explanation to its alerts; otherwise the most recent ones are shown.
  const named = slots.skuCodes.length > 0 ? await skuIdsByCode(deps, slots.skuCodes) : undefined;
  const relevant = named
    ? anomalies.filter((a) => a.skuId !== null && named.has(a.skuId))
    : anomalies;
  const alerts: AlertExplanation[] = relevant.slice(0, 10).map((a) => {
    const evidence = (a.evidence ?? {}) as Record<string, unknown>;
    const text = RULE_TEXT[a.ruleId]?.(evidence) ?? 'evidencia registrada por el detector';
    return {
      ruleId: a.ruleId,
      ruleVersion: a.ruleVersion,
      severity: a.severity,
      status: a.status,
      skuId: a.skuId,
      explanation: `Regla ${a.ruleId} (${a.ruleVersion}): ${text}.`,
      evidence: sql('anomaly', `anomaly:${a.id}`, a.ruleVersion, a.windowStart),
    };
  });
  const facts: Fact[] = alerts.map((a) => ({ text: a.explanation, evidence: a.evidence }));
  const skuIds = [
    ...new Set(alerts.map((a) => a.skuId).filter((id): id is string => id !== null)),
  ].slice(0, 5);
  if (skuIds.length > 0) {
    const stock = await deps.gateway.call('inventory', 'check_inventory', { sku_ids: skuIds });
    if (stock.ok) {
      for (const i of (
        stock.data as {
          items: {
            sku_id: string;
            available: number;
            on_hand?: number;
            reserved?: number;
            observed_at: string;
          }[];
        }
      ).items) {
        facts.push({
          text: `Balance actual de ${i.sku_id}: disponible ${String(i.available)}${i.on_hand !== undefined ? ` (on_hand ${String(i.on_hand)}, reservado ${String(i.reserved ?? 0)})` : ''}.`,
          evidence: sql('stock', `sku:${i.sku_id}`, 'balance', i.observed_at),
        });
      }
    }
  }
  return {
    specialist: 'inventory',
    status: 'ok',
    facts,
    inferences: [],
    uncertainty:
      alerts.length === 0 ? ['No hay alertas registradas por el detector para este tenant.'] : [],
    nextSteps: [
      'Las alertas no modifican inventario; cualquier ajuste lo decide una persona fuera de este asistente.',
    ],
    alerts,
  };
}
