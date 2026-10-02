/**
 * pnpm --filter @commerce/evals run adjudication sheet <dev|holdout> <reviewer-id>
 * pnpm --filter @commerce/evals run adjudication compare <dev|holdout> <reviewer-id>
 *
 * Files live in evals/adjudication/ops-eval-1.0.0/: `<split>.<reviewer>.jsonl` is the blind sheet
 * the reviewer fills in; `compare` writes `<split>.<reviewer>.agreement.md` and
 * `<split>.<reviewer>.disagreements.jsonl`. Protocol: openspec/changes/adjudicate-eval-labels.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  blindSheet,
  compareLabels,
  reportMarkdown,
  type DatasetCase,
  type SheetRow,
} from './adjudication.js';

const evalsRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataset = join(evalsRoot, 'fixtures', 'ops-eval', '1.0.0');
const outDir = join(evalsRoot, 'adjudication', 'ops-eval-1.0.0');

const readJsonl = async <T>(path: string): Promise<T[]> =>
  (await readFile(path, 'utf8'))
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);

const [command, split, reviewer] = process.argv.slice(2);
if (!['sheet', 'compare'].includes(command ?? '') || !['dev', 'holdout'].includes(split ?? '')) {
  console.error('usage: adjudication <sheet|compare> <dev|holdout> <reviewer-id>');
  process.exit(2);
}
if (!reviewer || !/^[a-z0-9-]{2,40}$/.test(reviewer)) {
  console.error('reviewer-id: 2-40 lowercase letters, digits or dashes (no names or emails)');
  process.exit(2);
}
const cases = await readJsonl<DatasetCase>(join(dataset, `${split ?? ''}.jsonl`));
const sheetPath = join(outDir, `${split ?? ''}.${reviewer}.jsonl`);
await mkdir(outDir, { recursive: true });

if (command === 'sheet') {
  if (existsSync(sheetPath)) {
    console.error(`${sheetPath} exists; refusing to overwrite a reviewer's work`);
    process.exit(1);
  }
  const rows = blindSheet(cases);
  await writeFile(sheetPath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`wrote a blind sheet of ${String(rows.length)} cases to ${sheetPath}`);
} else {
  const report = compareLabels(cases, await readJsonl<SheetRow>(sheetPath));
  const base = join(outDir, `${split ?? ''}.${reviewer}`);
  await writeFile(`${base}.agreement.md`, reportMarkdown(split ?? '', reviewer, report));
  await writeFile(
    `${base}.disagreements.jsonl`,
    report.disagreements.map((d) => JSON.stringify(d)).join('\n') + '\n',
  );
  console.log(reportMarkdown(split ?? '', reviewer, report));
}
