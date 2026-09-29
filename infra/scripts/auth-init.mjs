// Creates the key pair of the local development issuer (git-ignored under .local/auth).
// Usage: pnpm auth:init [--force]   Cloud deployments verify tokens from an OIDC provider instead.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dir = join(root, '.local', 'auth');
const privatePath = join(dir, 'issuer-private.jwk.json');
const jwksPath = join(dir, 'jwks.json');

if (existsSync(privatePath) && !process.argv.includes('--force')) {
  console.log(`Local issuer keys already exist in ${dir} (use --force to rotate).`);
  process.exit(0);
}

const requireFromApi = createRequire(join(root, 'apps', 'api', 'package.json'));
const contracts = await import(pathToFileURL(requireFromApi.resolve('@commerce/contracts')).href);
const { privateJwk, jwks } = contracts.generateLocalIssuerKeys();
await mkdir(dir, { recursive: true });
await writeFile(privatePath, JSON.stringify(privateJwk, null, 2), { mode: 0o600 });
await writeFile(jwksPath, JSON.stringify(jwks, null, 2));
console.log(`Local issuer keys written to ${dir}`);
