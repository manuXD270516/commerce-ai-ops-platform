// Generates the secret files of the production-like stack under .local/prod (git-ignored):
// random database and Redis passwords, connection URLs, a PII encryption key and a fresh issuer
// key pair. Nothing is reused from the development .env. Usage: pnpm prod:secrets [--force]
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = join(root, '.local', 'prod');
if (existsSync(join(dir, 'postgres_password')) && !process.argv.includes('--force')) {
  console.log(`secrets already exist in ${dir} (use --force to rotate; then recreate the stack)`);
  process.exit(0);
}
const contracts = await import(
  pathToFileURL(join(root, 'packages', 'contracts', 'dist', 'index.js')).href
);
const secret = () => randomBytes(24).toString('base64url');
const admin = secret();
const migrator = secret();
const runtime = secret();
const redis = secret();
const { privateJwk, jwks } = contracts.generateLocalIssuerKeys();
const files = {
  postgres_password: admin,
  redis_password: redis,
  database_admin_url: `postgres://commerce_admin:${admin}@postgres:5432/commerce`,
  database_migrator_url: `postgres://commerce_migrator:${migrator}@postgres:5432/commerce`,
  database_url: `postgres://commerce_runtime:${runtime}@postgres:5432/commerce`,
  redis_url: `redis://:${redis}@redis:6379`,
  pii_key: randomBytes(32).toString('hex'),
  'jwks.json': JSON.stringify(jwks),
  'issuer-private.jwk.json': JSON.stringify(privateJwk),
};
await mkdir(dir, { recursive: true });
for (const [name, value] of Object.entries(files)) {
  await writeFile(join(dir, name), value, { mode: 0o600 });
}
console.log(`wrote ${String(Object.keys(files).length)} secret files to ${dir}`);
