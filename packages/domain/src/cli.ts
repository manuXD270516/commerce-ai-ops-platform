import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyRetention,
  createDb,
  createPool,
  hashEmbedder,
  migrate,
  seedCommerceDomain,
  seedKnowledgeCorpus,
  type MigrateUrls,
} from './index.js';

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

async function hasTenants(migratorUrl: string): Promise<boolean> {
  const pool = createPool(migratorUrl);
  try {
    const { rows } = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM commerce.tenants',
    );
    return (rows[0]?.n ?? 0) > 0;
  } finally {
    await pool.end();
  }
}

loadEnv();
const command = process.argv[2] ?? 'migrate';
if (command === 'migrate') {
  const ran = await migrate(urls());
  console.log(JSON.stringify({ ran }));
} else if (command === 'seed') {
  const key = process.env.PII_ENCRYPTION_KEY;
  if (!key) throw new Error('PII_ENCRYPTION_KEY is required');
  // The seed resets the synthetic fixtures. Deployed stacks pass --if-empty so a re-run of the
  // migration job (restart, redeploy, dependency start) never wipes accumulated state.
  if (process.argv.includes('--if-empty') && (await hasTenants(urls().migratorUrl))) {
    console.log(JSON.stringify({ seeded: false, reason: 'database already has tenants' }));
    process.exit(0);
  }
  await seedCommerceDomain(urls().migratorUrl, key);
  // The corpus goes through the runtime role and the ingestion service identity, like any ingest.
  const db = createDb(createPool(urls().runtimeUrl));
  try {
    const docs = await seedKnowledgeCorpus(db, hashEmbedder());
    console.log(
      JSON.stringify({
        seeded: 'commerce-domain@0.3.0',
        knowledge: {
          corpus: 'knowledge@0.1.0',
          versions: docs.length,
          new: docs.filter((d) => !d.duplicate).length,
        },
      }),
    );
  } finally {
    await db.destroy();
  }
} else if (command === 'retention') {
  console.log(JSON.stringify({ retention: await applyRetention(urls().migratorUrl) }));
} else {
  throw new Error(`unknown command ${command}`);
}
