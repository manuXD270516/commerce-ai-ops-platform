import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, seedCommerceDomain, type MigrateUrls } from './index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function loadEnv(): void {
  const envFile = join(repoRoot, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

function urls(): MigrateUrls {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  const migratorUrl = process.env.DATABASE_MIGRATOR_URL;
  const runtimeUrl = process.env.DATABASE_URL;
  if (!adminUrl || !migratorUrl || !runtimeUrl) {
    throw new Error('DATABASE_ADMIN_URL, DATABASE_MIGRATOR_URL and DATABASE_URL are required');
  }
  return { adminUrl, migratorUrl, runtimeUrl };
}

loadEnv();
const command = process.argv[2] ?? 'migrate';
if (command === 'migrate') {
  const ran = await migrate(urls());
  console.log(JSON.stringify({ ran }));
} else if (command === 'seed') {
  const key = process.env.PII_ENCRYPTION_KEY;
  if (!key) throw new Error('PII_ENCRYPTION_KEY is required');
  await seedCommerceDomain(urls().migratorUrl, key);
  console.log(JSON.stringify({ seeded: 'commerce-domain@0.2.0' }));
} else {
  throw new Error(`unknown command ${command}`);
}
