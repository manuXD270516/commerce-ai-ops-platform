// Generates src/generated/*.ts from schemas/*.schema.json. With --check, fails if output drifts.
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schemasDir = join(root, 'schemas');
const outDir = join(root, 'src', 'generated');
const check = process.argv.includes('--check');

const banner = '/* Generated from schemas/ by scripts/generate-types.mjs. Do not edit. */';

const files = (await readdir(schemasDir)).filter((f) => f.endsWith('.schema.json')).sort();
const outputs = new Map();

for (const file of files) {
  const schema = JSON.parse(await readFile(join(schemasDir, file), 'utf8'));
  const ts = await compile(schema, schema.title, {
    bannerComment: banner,
    additionalProperties: false,
    maxItems: -1,
    cwd: schemasDir,
    style: { singleQuote: true, printWidth: 100, trailingComma: 'all' },
  });
  outputs.set(basename(file, '.schema.json') + '.ts', ts);
}

const index =
  banner +
  '\n' +
  [...outputs.keys()]
    .map((f) => `export type * from './${f.replace(/\.ts$/, '.js')}';`)
    .join('\n') +
  '\n';
outputs.set('index.ts', index);

let drift = [];
for (const [name, content] of outputs) {
  const target = join(outDir, name);
  if (check) {
    const current = await readFile(target, 'utf8').catch(() => null);
    if (current !== content) drift.push(name);
  } else {
    await mkdir(outDir, { recursive: true });
    await writeFile(target, content);
  }
}

if (check) {
  if (drift.length > 0) {
    console.error(
      `Generated types are stale: ${drift.join(', ')}. Run: pnpm --filter @commerce/contracts generate`,
    );
    process.exit(1);
  }
  console.log(`Generated types up to date (${files.length} schemas).`);
} else {
  console.log(`Generated ${outputs.size} files in src/generated.`);
}
