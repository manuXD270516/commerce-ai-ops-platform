/**
 * Deterministic slot extraction. It parses what the user wrote (ids, amounts, sizes); it never
 * decides prices, stock, SLA or permissions, which stay in SQL and domain commands.
 */
export interface Slots {
  readonly orderIds: readonly string[];
  /** Budget in minor units; "menos de" is strict (<), "hasta"/"con"/"presupuesto" is inclusive. */
  readonly budget?: { readonly operator: 'lt' | 'lte'; readonly minor: number };
  readonly ramGb?: number;
  readonly skuCodes: readonly string[];
  readonly category?: 'notebook' | 'accessory';
  readonly action?: 'request_cancellation';
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const SKU = /\b[A-Z]{2,5}(?:-[A-Z0-9]{1,5}){1,3}\b/g;
const AMOUNT = String.raw`(?:usd|us\$|\$)?\s*(\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,](\d{2}))?\s*(?:usd|d[oó]lares)?`;

export function extractSlots(message: string): Slots {
  const lower = message.toLowerCase();
  const orderIds = [...new Set((message.match(UUID) ?? []).map((id) => id.toLowerCase()))];
  const skuCodes = [...new Set(message.match(SKU) ?? [])];
  const ram = /(\d{1,3})\s*gb/i.exec(message);
  return {
    orderIds,
    skuCodes,
    ...budgetOf(lower),
    ...(ram?.[1] ? { ramGb: Number(ram[1]) } : {}),
    ...categoryOf(lower),
    ...(/\b(cancel|anul)/.test(lower) ? { action: 'request_cancellation' as const } : {}),
  };
}

function budgetOf(lower: string): Pick<Slots, 'budget'> {
  const strict = new RegExp(String.raw`menos de\s+${AMOUNT}`, 'i').exec(lower);
  const inclusive = new RegExp(
    String.raw`(?:hasta|presupuesto de|con|m[aá]ximo)\s+${AMOUNT}`,
    'i',
  ).exec(lower);
  const match = strict ?? inclusive;
  if (!match?.[1]) return {};
  // Spanish and English thousands separators: "1.500", "1,500" and "1500" are the same amount.
  const units = Number(match[1].replace(/[.,]/g, ''));
  const cents = match[2] ? Number(match[2]) : 0;
  if (!Number.isSafeInteger(units) || units <= 0) return {};
  // Only amounts in USD context: an explicit currency marker or a plain amount with "menos de".
  if (!/(usd|us\$|\$|d[oó]lar)/.test(match[0]) && !strict) return {};
  return { budget: { operator: strict ? 'lt' : 'lte', minor: units * 100 + cents } };
}

function categoryOf(lower: string): Pick<Slots, 'category'> {
  if (/(mouse|rat[oó]n|teclado|accesorio)/.test(lower)) return { category: 'accessory' };
  if (/(notebook|laptop|port[aá]til|computadora|equipo|m[aá]quina)/.test(lower)) {
    return { category: 'notebook' };
  }
  return {};
}
