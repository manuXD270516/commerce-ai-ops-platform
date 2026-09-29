import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildReport,
  correlationContractTarget,
  expectedFromGates,
  FixtureIntegrityError,
  loadDataset,
  observed,
  runExactMatchSuite,
  simulatedProviderTarget,
  validateReport,
} from '../src/index.js';

const datasetDir = join(import.meta.dirname, '..', 'fixtures', 'harness-selftest', '0.1.0');

describe('fixtures', () => {
  it('loads the versioned dataset when checksums match', async () => {
    const dataset = await loadDataset(datasetDir);
    expect(dataset.manifest.version).toBe('0.1.0');
    expect(dataset.cases.length).toBe(12);
    expect(dataset.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a dataset whose content drifted from its manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'evals-'));
    await cp(datasetDir, dir, { recursive: true });
    await writeFile(join(dir, 'cases.jsonl'), '{"id":"x","suite":"s","input":1,"expected":1}\n');
    await expect(loadDataset(dir)).rejects.toBeInstanceOf(FixtureIntegrityError);
  });
});

describe('report statuses', () => {
  it('labels a real target MEASURED with a denominator', async () => {
    const report = runExactMatchSuite(await loadDataset(datasetDir), correlationContractTarget, {
      suite: 'correlation-contract',
      metric: 'correlation_contract_conformance',
      dimension: 'harness',
      source: 'test',
      threshold: { operator: '==', value: 1 },
    });
    expect(validateReport(report)).toEqual([]);
    expect(report.results[0]).toMatchObject({
      status: 'MEASURED',
      value: 1,
      numerator: 8,
      denominator: 8,
      passed: true,
    });
  });

  it('labels a simulated target SIMULATED and counts its mismatches', async () => {
    const report = runExactMatchSuite(await loadDataset(datasetDir), simulatedProviderTarget, {
      suite: 'simulated-selftest',
      metric: 'selftest_exact_match',
      dimension: 'harness',
      source: 'test',
    });
    expect(validateReport(report)).toEqual([]);
    expect(report.results[0]).toMatchObject({ status: 'SIMULATED', numerator: 3, denominator: 4 });
    expect(report.summary.measured).toBe(0);
  });

  it('rejects a simulated run that claims MEASURED results', () => {
    const report = buildReport({
      suite: 'forged',
      target: { id: 'simulated-provider', mode: 'simulated', description: 'x' },
      startedAt: new Date(),
      results: [
        observed('MEASURED', {
          metric: 'api_read_latency_p95',
          dimension: 'latency',
          unit: 'ms',
          source: 'test',
          value: 120,
          denominator: 10,
        }),
      ],
    });
    expect(validateReport(report)).toEqual([
      'api_read_latency_p95: status MEASURED is not allowed for a simulated target',
    ]);
  });

  it('rejects EXPECTED results that carry an observed value', () => {
    const [gate] = expectedFromGates(
      [
        {
          metric: 'retrieval_recall_at_5',
          dimension: 'retrieval_quality',
          unit: 'ratio',
          threshold: { operator: '>=', value: 0.9 },
        },
      ],
      'docs/rag-evals.md',
    );
    const report = buildReport({
      suite: 'gates',
      target: { id: 'gates', mode: 'none', description: 'x' },
      startedAt: new Date(),
      results: [{ ...gate!, value: 0.95 }],
    });
    expect(validateReport(report).length).toBeGreaterThan(0);
  });

  it('rejects observations without a denominator', () => {
    const report = buildReport({
      suite: 'no-n',
      target: { id: 'real', mode: 'real', description: 'x' },
      startedAt: new Date(),
      results: [
        { metric: 'm', dimension: 'd', status: 'MEASURED', unit: 'ms', source: 's', value: 1 },
      ],
    });
    expect(validateReport(report).length).toBeGreaterThan(0);
  });
});
