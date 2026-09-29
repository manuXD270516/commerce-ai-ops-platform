import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface DatasetManifest {
  readonly id: string;
  readonly version: string;
  readonly kind: 'synthetic';
  readonly description: string;
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
}

export interface EvalCase {
  readonly id: string;
  readonly suite: string;
  readonly input: unknown;
  readonly expected: unknown;
  readonly simulated_output?: unknown;
}

export interface LoadedDataset {
  readonly manifest: DatasetManifest;
  /** sha256 over the manifest's file digests; identifies the exact dataset content. */
  readonly sha256: string;
  readonly cases: readonly EvalCase[];
}

export class FixtureIntegrityError extends Error {}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

/**
 * Loads a versioned dataset and refuses to run if any file differs from its manifest checksum,
 * so a report can never silently describe edited fixtures.
 */
export async function loadDataset(dir: string): Promise<LoadedDataset> {
  const manifest = JSON.parse(
    await readFile(join(dir, 'manifest.json'), 'utf8'),
  ) as DatasetManifest;
  const cases: EvalCase[] = [];
  for (const file of manifest.files) {
    const content = await readFile(join(dir, file.path));
    const actual = sha256(content);
    if (actual !== file.sha256) {
      throw new FixtureIntegrityError(
        `${manifest.id}@${manifest.version}: ${file.path} checksum ${actual} != manifest ${file.sha256}`,
      );
    }
    for (const line of content.toString('utf8').split('\n')) {
      if (line.trim() !== '') cases.push(JSON.parse(line) as EvalCase);
    }
  }
  const ids = new Set(cases.map((c) => c.id));
  if (ids.size !== cases.length) {
    throw new FixtureIntegrityError(`${manifest.id}@${manifest.version}: duplicate case ids`);
  }
  return {
    manifest,
    sha256: sha256(manifest.files.map((f) => `${f.path}:${f.sha256}`).join('\n')),
    cases,
  };
}
