/**
 * Two-reviewer label adjudication for ops-eval (follow-up of M10, change adjudicate-eval-labels).
 * A second reviewer labels a blind sheet (inputs only); this module compares the two label sets
 * field by field, reports agreement with chance-corrected statistics and lists every
 * disagreement for the adjudication meeting. It never changes the dataset itself.
 */

export interface CaseLabels {
  intents?: string[] | null;
  decision?: string | null;
  tools_required?: string[] | null;
  tools_forbidden?: string[] | null;
  escalation?: boolean | null;
  eligible?: string[] | null;
  grades?: Record<string, number> | null;
  no_candidates?: boolean | null;
  effects?: string | null;
}

export interface DatasetCase {
  id: string;
  suite: string;
  family: string;
  category: string;
  input: { role: string; message: string };
  expected: CaseLabels & Record<string, unknown>;
}

export interface SheetRow {
  id: string;
  category: string;
  input: { role: string; message: string };
  labels: CaseLabels;
  notes: string;
}

/** Label fields a reviewer fills for each category (args are checked separately by schema). */
export function fieldsFor(category: string): (keyof CaseLabels)[] {
  const common: (keyof CaseLabels)[] = [
    'intents',
    'decision',
    'tools_required',
    'tools_forbidden',
    'effects',
  ];
  if (category === 'investigation') return [...common, 'escalation'];
  if (category === 'recommendation') return [...common, 'eligible', 'grades', 'no_candidates'];
  return common;
}

/** Blind sheet: inputs and empty label slots, never the author's labels. */
export function blindSheet(cases: readonly DatasetCase[]): SheetRow[] {
  return cases.map((c) => ({
    id: c.id,
    category: c.category,
    input: c.input,
    labels: Object.fromEntries(fieldsFor(c.category).map((f) => [f, null])),
    notes: '',
  }));
}

const canonical = (v: unknown): string => {
  if (v === undefined || v === null) return '∅';
  if (Array.isArray(v)) return JSON.stringify([...(v as unknown[])].map(String).sort());
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return JSON.stringify(entries);
  }
  return JSON.stringify(v);
};

/** Cohen's kappa for two raters over categorical items (values compared canonically). */
export function cohenKappa(a: readonly unknown[], b: readonly unknown[]): number | null {
  if (a.length !== b.length || a.length === 0) return null;
  const x = a.map(canonical);
  const y = b.map(canonical);
  const n = x.length;
  const observed = x.filter((v, i) => v === y[i]).length / n;
  const categories = new Set([...x, ...y]);
  let expected = 0;
  for (const c of categories) {
    expected += (x.filter((v) => v === c).length / n) * (y.filter((v) => v === c).length / n);
  }
  if (expected === 1) return observed === 1 ? 1 : 0;
  return (observed - expected) / (1 - expected);
}

export interface FieldAgreement {
  field: keyof CaseLabels;
  n: number;
  agree: number;
  ratio: number;
  kappa: number | null;
}

export interface Disagreement {
  id: string;
  field: keyof CaseLabels;
  author: unknown;
  reviewer: unknown;
}

export interface AdjudicationReport {
  cases: number;
  labelled: number;
  missing: string[];
  fields: FieldAgreement[];
  disagreements: Disagreement[];
}

/**
 * Compares the author's labels with a reviewer's sheet. Cases the reviewer left unlabelled
 * (any null field) are listed as missing and excluded from the statistics.
 */
export function compareLabels(
  cases: readonly DatasetCase[],
  reviewer: readonly SheetRow[],
): AdjudicationReport {
  const byId = new Map(reviewer.map((r) => [r.id, r]));
  const missing: string[] = [];
  const pairs: { c: DatasetCase; r: SheetRow }[] = [];
  for (const c of cases) {
    const r = byId.get(c.id);
    if (
      !r ||
      fieldsFor(c.category).some((f) => r.labels[f] === null || r.labels[f] === undefined)
    ) {
      missing.push(c.id);
      continue;
    }
    pairs.push({ c, r });
  }
  const allFields = [
    ...new Set(pairs.flatMap(({ c }) => fieldsFor(c.category))),
  ] as (keyof CaseLabels)[];
  const disagreements: Disagreement[] = [];
  const fields = allFields.map((field) => {
    const relevant = pairs.filter(({ c }) => fieldsFor(c.category).includes(field));
    const author = relevant.map(({ c }) => c.expected[field] ?? null);
    const second = relevant.map(({ r }) => r.labels[field] ?? null);
    let agree = 0;
    relevant.forEach(({ c }, i) => {
      if (canonical(author[i]) === canonical(second[i])) agree += 1;
      else disagreements.push({ id: c.id, field, author: author[i], reviewer: second[i] });
    });
    return {
      field,
      n: relevant.length,
      agree,
      ratio: relevant.length ? agree / relevant.length : 0,
      kappa: cohenKappa(author, second),
    };
  });
  return { cases: cases.length, labelled: pairs.length, missing, fields, disagreements };
}

export function reportMarkdown(split: string, reviewerId: string, r: AdjudicationReport): string {
  const fmt = (v: number | null) => (v === null ? '—' : v.toFixed(3));
  return [
    `# Label agreement: ops-eval@1.0.0 ${split}, author vs ${reviewerId}`,
    '',
    `Cases ${String(r.cases)}, labelled by the reviewer ${String(r.labelled)}, missing ${String(r.missing.length)}.`,
    '',
    '| Field | n | Agree | Ratio | Cohen κ |',
    '|---|---|---|---|---|',
    ...r.fields.map(
      (f) =>
        `| ${f.field} | ${String(f.n)} | ${String(f.agree)} | ${fmt(f.ratio)} | ${fmt(f.kappa)} |`,
    ),
    '',
    `Disagreements to adjudicate: ${String(r.disagreements.length)} (listed in the .disagreements.jsonl file).`,
    '',
  ].join('\n');
}
