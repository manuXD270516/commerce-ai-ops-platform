import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

const require = createRequire(import.meta.url);
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

/**
 * EXPECTED: a target with no observed value. SIMULATED: observed against a simulated target,
 * never evidence about a real provider. MEASURED: observed against real code or infrastructure,
 * always with a denominator and the environment where it ran.
 */
export type ResultStatus = 'EXPECTED' | 'SIMULATED' | 'MEASURED';
export type TargetMode = 'real' | 'simulated' | 'none';

export interface Threshold {
  readonly operator: '>=' | '<=' | '<' | '>' | '==';
  readonly value: number;
}

export interface EvalResult {
  readonly metric: string;
  readonly dimension: string;
  readonly status: ResultStatus;
  readonly unit: string;
  readonly source: string;
  readonly threshold?: Threshold;
  readonly value?: number;
  readonly numerator?: number;
  readonly denominator?: number;
  readonly passed?: boolean;
  readonly notes?: string;
}

export interface EvalTargetInfo {
  readonly id: string;
  readonly mode: TargetMode;
  readonly description: string;
}

export interface DatasetRef {
  readonly id: string;
  readonly version: string;
  readonly sha256: string;
  readonly cases: number;
}

export interface EvalReport {
  readonly schema_version: '0.1.0';
  readonly run: {
    readonly id: string;
    readonly suite: string;
    readonly started_at: string;
    readonly finished_at: string;
    readonly commit: { readonly sha: string; readonly dirty: boolean };
    readonly environment: {
      readonly node: string;
      readonly platform: string;
      readonly arch: string;
      readonly ci: boolean;
    };
    readonly target: EvalTargetInfo;
    readonly dataset?: DatasetRef;
  };
  readonly results: readonly EvalResult[];
  readonly summary: {
    readonly expected: number;
    readonly simulated: number;
    readonly measured: number;
    readonly failed: number;
  };
}

export function meetsThreshold(value: number, threshold: Threshold): boolean {
  switch (threshold.operator) {
    case '>=':
      return value >= threshold.value;
    case '<=':
      return value <= threshold.value;
    case '<':
      return value < threshold.value;
    case '>':
      return value > threshold.value;
    case '==':
      return value === threshold.value;
  }
}

export interface ObservationInput {
  readonly metric: string;
  readonly dimension: string;
  readonly unit: string;
  readonly source: string;
  readonly value: number;
  readonly denominator: number;
  readonly numerator?: number;
  readonly threshold?: Threshold;
  readonly notes?: string;
}

/** Builds a SIMULATED or MEASURED result; `passed` is computed only when a threshold exists. */
export function observed(status: 'SIMULATED' | 'MEASURED', input: ObservationInput): EvalResult {
  return {
    ...input,
    status,
    ...(input.threshold ? { passed: meetsThreshold(input.value, input.threshold) } : {}),
  };
}

export interface GateDefinition {
  readonly metric: string;
  readonly dimension: string;
  readonly unit: string;
  readonly threshold: Threshold;
  readonly notes?: string;
}

export function expectedFromGates(gates: readonly GateDefinition[], source: string): EvalResult[] {
  return gates.map((gate) => ({ ...gate, status: 'EXPECTED' as const, source }));
}

function gitInfo(): { sha: string; dirty: boolean } {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty =
      execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
    return { sha, dirty };
  } catch {
    return { sha: 'unknown', dirty: true };
  }
}

export interface BuildReportInput {
  readonly suite: string;
  readonly target: EvalTargetInfo;
  readonly startedAt: Date;
  readonly results: readonly EvalResult[];
  readonly dataset?: DatasetRef;
}

export function buildReport(input: BuildReportInput): EvalReport {
  const stamp = input.startedAt.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  const count = (status: ResultStatus) => input.results.filter((r) => r.status === status).length;
  return {
    schema_version: '0.1.0',
    run: {
      id: `${input.suite}-${stamp}-${randomBytes(2).toString('hex')}`,
      suite: input.suite,
      started_at: input.startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      commit: gitInfo(),
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        ci: process.env.CI === 'true',
      },
      target: input.target,
      ...(input.dataset ? { dataset: input.dataset } : {}),
    },
    results: input.results,
    summary: {
      expected: count('EXPECTED'),
      simulated: count('SIMULATED'),
      measured: count('MEASURED'),
      failed: input.results.filter((r) => r.passed === false).length,
    },
  };
}

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validateSchema = ajv.compile<EvalReport>(
  require('../schemas/eval-report.schema.json') as Record<string, unknown>,
);

const STATUS_FOR_MODE: Record<TargetMode, ResultStatus> = {
  real: 'MEASURED',
  simulated: 'SIMULATED',
  none: 'EXPECTED',
};

/**
 * Schema validation plus rules the schema cannot express: a simulated target can only yield
 * SIMULATED results, a real target MEASURED ones, and EXPECTED targets are never observations.
 */
export function validateReport(report: unknown): string[] {
  if (!validateSchema(report)) {
    return (validateSchema.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`);
  }
  const errors: string[] = [];
  const mode = report.run.target.mode;
  for (const result of report.results) {
    if (result.status !== 'EXPECTED' && result.status !== STATUS_FOR_MODE[mode]) {
      errors.push(`${result.metric}: status ${result.status} is not allowed for a ${mode} target`);
    }
    if (result.threshold && result.status !== 'EXPECTED' && result.passed === undefined) {
      errors.push(`${result.metric}: threshold present but passed not computed`);
    }
    if (result.numerator !== undefined && result.denominator !== undefined) {
      if (result.numerator > result.denominator) {
        errors.push(`${result.metric}: numerator exceeds denominator`);
      }
    }
  }
  return errors;
}

export function renderMarkdown(report: EvalReport): string {
  const { run } = report;
  const lines = [
    `# ${run.suite}`,
    '',
    `- Run: \`${run.id}\``,
    `- Commit: \`${run.commit.sha}\`${run.commit.dirty ? ' (working tree dirty)' : ''}`,
    `- Target: \`${run.target.id}\` (mode: ${run.target.mode}) — ${run.target.description}`,
    `- Environment: Node ${run.environment.node}, ${run.environment.platform}/${run.environment.arch}, CI=${run.environment.ci}`,
    ...(run.dataset
      ? [
          `- Dataset: ${run.dataset.id}@${run.dataset.version}, ${run.dataset.cases} cases, sha256 \`${run.dataset.sha256}\``,
        ]
      : []),
    '',
    '| Status | Metric | Dimension | Value | n | Threshold | Passed |',
    '|---|---|---|---|---|---|---|',
    ...report.results
      .map((r) =>
        [
          r.status,
          r.metric,
          r.dimension,
          r.value === undefined ? '—' : `${r.value} ${r.unit}`,
          r.denominator ?? '—',
          r.threshold ? `${r.threshold.operator} ${r.threshold.value}` : '—',
          r.passed === undefined ? '—' : r.passed ? 'yes' : 'NO',
        ].join(' | '),
      )
      .map((row) => `| ${row} |`),
    '',
    ...report.results.filter((r) => r.notes).map((r) => `- \`${r.metric}\`: ${r.notes ?? ''}`),
    '',
    'EXPECTED = objetivo propuesto sin medición. SIMULATED = ejecutado contra un objetivo simulado; no describe ningún proveedor real. MEASURED = ejecutado contra código o infraestructura real en el entorno indicado.',
    '',
  ];
  return lines.join('\n');
}

export async function writeReport(report: EvalReport, outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const base = join(outDir, report.run.id);
  await writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(`${base}.md`, renderMarkdown(report));
  return `${base}.json`;
}
