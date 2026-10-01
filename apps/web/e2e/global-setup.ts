import {
  FIXTURES,
  anomalyDetectorActor,
  createDb,
  detectAnomalies,
  createPool,
  hashEmbedder,
  migrate,
  seedCommerceDomain,
  seedKnowledgeCorpus,
} from '@commerce/domain';

/** Fresh fixtures for every E2E run: schema, synthetic commerce data and the knowledge corpus. */
export default async function globalSetup(): Promise<void> {
  const { DATABASE_ADMIN_URL, DATABASE_MIGRATOR_URL, DATABASE_URL, PII_ENCRYPTION_KEY } =
    process.env;
  if (!DATABASE_ADMIN_URL || !DATABASE_MIGRATOR_URL || !DATABASE_URL || !PII_ENCRYPTION_KEY) {
    throw new Error(
      'E2E needs the DATABASE_* URLs and PII_ENCRYPTION_KEY (copy .env.example to .env)',
    );
  }
  await migrate({
    adminUrl: DATABASE_ADMIN_URL,
    migratorUrl: DATABASE_MIGRATOR_URL,
    runtimeUrl: DATABASE_URL,
  });
  await seedCommerceDomain(DATABASE_MIGRATOR_URL, PII_ENCRYPTION_KEY);
  const db = createDb(createPool(DATABASE_URL));
  try {
    await seedKnowledgeCorpus(db, hashEmbedder());
    // Alerts for the inventory views, from the deterministic detector at the fixture clock.
    await detectAnomalies(
      db,
      anomalyDetectorActor(FIXTURES.tenants.acme),
      new Date('2026-09-29T12:00:00.000Z'),
    );
  } finally {
    await db.destroy();
  }
}
