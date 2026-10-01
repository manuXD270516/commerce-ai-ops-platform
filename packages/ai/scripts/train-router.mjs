// Trains the router's bounded classifier from router@0.1.0 train split only and writes
// models/nb-model.v1.json. With --check, fails if the committed model differs from a retrain.
// Requires `pnpm --filter @commerce/ai build` (uses dist).
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trainNaiveBayes } from '../dist/router/naive-bayes.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const trainFile = join(root, '..', '..', 'evals', 'fixtures', 'router', '0.1.0', 'train.jsonl');
const target = join(root, 'models', 'nb-model.v1.json');

const raw = await readFile(trainFile, 'utf8');
const examples = raw
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l))
  .map((c) => ({ text: c.input.message, label: c.expected.intents[0] }));
const model = trainNaiveBayes(examples, {
  version: 'nb-model.v1',
  trainedOn: `router@0.1.0/train.jsonl sha256:${createHash('sha256').update(raw).digest('hex')}`,
});
const content = JSON.stringify(model, null, 1) + '\n';
if (process.argv.includes('--check')) {
  const current = await readFile(target, 'utf8').catch(() => '');
  if (current !== content) {
    console.error(
      'models/nb-model.v1.json is stale: run pnpm --filter @commerce/ai run train-router',
    );
    process.exit(1);
  }
  console.log('router model up to date');
} else {
  await writeFile(target, content);
  console.log(
    `trained ${model.version} on ${examples.length} examples, ${model.vocabularySize} features`,
  );
}
