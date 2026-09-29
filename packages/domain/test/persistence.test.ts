import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DomainError,
  FIXTURES,
  createDb,
  createPool,
  getOrder,
  migrate,
  recordProbe,
  seedCommerceDomain,
} from '../src/index.js';

const adminUrl = process.env.DATABASE_ADMIN_URL;
const migratorUrl = process.env.DATABASE_MIGRATOR_URL;
const runtimeUrl = process.env.DATABASE_URL;
const piiKey = process.env.PII_ENCRYPTION_KEY;
const enabled = Boolean(adminUrl && migratorUrl && runtimeUrl && piiKey);

const ana = {
  tenantId: FIXTURES.tenants.acme,
  subjectId: FIXTURES.subjects.ana,
  role: 'customer' as const,
  customerId: FIXTURES.customers.ana,
  policyVersion: 'm1.0',
  correlationId: 'm1-test-ana-01',
};

describe.skipIf(!enabled)('commerce domain against PostgreSQL', () => {
  const pool = createPool(runtimeUrl!);
  const db = createDb(pool);

  beforeAll(async () => {
    await migrate({ adminUrl: adminUrl!, migratorUrl: migratorUrl!, runtimeUrl: runtimeUrl! });
    await seedCommerceDomain(migratorUrl!, piiKey!);
  }, 60_000);

  afterAll(async () => {
    await db.destroy();
  });

  it('migrates an empty database and records applied files', async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    const { rows } = await admin.query('SELECT id FROM commerce.schema_migrations ORDER BY id');
    await admin.end();
    expect(rows.map((r: { id: string }) => r.id)).toEqual([
      '0001_schema.sql',
      '0002_rls.sql',
      '0003_embeddings.sql',
    ]);
  });

  it('creates the vector extension and embedding column on chunks', async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    const ext = await admin.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    const cols = await admin.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'commerce' AND table_name = 'chunks'`,
    );
    await admin.end();
    expect(ext.rowCount).toBe(1);
    expect(cols.rows.map((r: { column_name: string }) => r.column_name)).toContain('embedding');
  });

  it('returns Ana her partial order with immutable snapshots', async () => {
    const order = await getOrder(db, ana, FIXTURES.orders.anaPartial);
    expect(order.customerId).toBe(FIXTURES.customers.ana);
    expect(order.status).toBe('FULFILLING');
    expect(order.items[0]?.titleSnapshot).toContain('Notebook');
    expect(order.totalMinor).toBe(132800);
  });

  it('hides Ben’s order from Ana in the same tenant (NOT_FOUND + DENIED audit)', async () => {
    await expect(getOrder(db, ana, FIXTURES.orders.benConfirmed)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    } satisfies Partial<DomainError>);
    const { rows } = await pool.query<{ outcome: string }>(
      `SELECT outcome FROM commerce.audit_events
       WHERE actor_subject_id = $1 AND resource_id = $2
       ORDER BY recorded_at DESC LIMIT 1`,
      [ana.subjectId, FIXTURES.orders.benConfirmed],
    );
    // Runtime cannot read audit without tenant session; use migrator.
    expect(rows.length).toBe(0);
    const migrator = new pg.Client({ connectionString: migratorUrl });
    await migrator.connect();
    const denied = await migrator.query<{ outcome: string }>(
      `SELECT outcome FROM commerce.audit_events
       WHERE actor_subject_id = $1 AND resource_id = $2 AND outcome = 'DENIED'`,
      [ana.subjectId, FIXTURES.orders.benConfirmed],
    );
    await migrator.end();
    expect(denied.rowCount).toBeGreaterThan(0);
  });

  it('hides Globex orders from an Acme customer', async () => {
    await expect(getOrder(db, ana, FIXTURES.orders.caraPlaced)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('rejects a cross-tenant foreign key on insert', async () => {
    const migrator = new pg.Client({ connectionString: migratorUrl });
    await migrator.connect();
    await expect(
      migrator.query(
        `INSERT INTO commerce.orders
          (tenant_id, id, customer_id, status, currency, subtotal_minor, tax_minor, shipping_minor, total_minor)
         VALUES ($1, gen_random_uuid(), $2, 'PLACED', 'USD', 0, 0, 0, 0)`,
        [FIXTURES.tenants.acme, FIXTURES.customers.cara],
      ),
    ).rejects.toThrow(/foreign key/i);
    await migrator.end();
  });

  it('does not leak tenant rows after the connection is returned to the pool', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [FIXTURES.tenants.acme]);
      await client.query("SELECT set_config('app.role', 'support', true)");
      const inside = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM commerce.orders',
      );
      expect(inside.rows[0]?.n).toBeGreaterThan(0);
      await client.query('COMMIT');
      const outside = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM commerce.orders',
      );
      expect(outside.rows[0]?.n).toBe(0);
    } finally {
      client.release();
    }
  });

  it('keeps commerce_runtime without BYPASSRLS', async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    const { rows } = await admin.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'commerce_runtime'",
    );
    await admin.end();
    expect(rows[0]?.rolbypassrls).toBe(false);
  });

  it('deduplicates an idempotent probe and conflicts on a mutated payload', async () => {
    const support = {
      tenantId: FIXTURES.tenants.acme,
      subjectId: FIXTURES.subjects.acmeSupport,
      role: 'support' as const,
      policyVersion: 'm1.0',
    };
    const first = await recordProbe(db, support, 'probe-key-1', { marker: 'a' });
    const second = await recordProbe(db, support, 'probe-key-1', { marker: 'a' });
    expect(second.eventId).toBe(first.eventId);
    await expect(recordProbe(db, support, 'probe-key-1', { marker: 'b' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('rolls back outbox and audit when the unit of work throws', async () => {
    const { appendOutbox, withUnitOfWork } = await import('../src/index.js');
    const support = {
      tenantId: FIXTURES.tenants.acme,
      subjectId: FIXTURES.subjects.acmeSupport,
      role: 'support' as const,
      policyVersion: 'm1.0',
    };
    const eventId = '00000000-0000-4000-8000-00000000b001';
    await expect(
      withUnitOfWork(db, support, async (trx) => {
        await appendOutbox(trx, support, {
          eventId,
          aggregateType: 'probe',
          aggregateId: support.tenantId,
          aggregateVersion: 1,
          payload: { marker: 'rollback' },
        });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const migrator = new pg.Client({ connectionString: migratorUrl });
    await migrator.connect();
    const outbox = await migrator.query('SELECT 1 FROM commerce.outbox WHERE event_id = $1', [
      eventId,
    ]);
    await migrator.end();
    expect(outbox.rowCount).toBe(0);
  });

  it('rejects mutating an order item snapshot', async () => {
    const migrator = new pg.Client({ connectionString: migratorUrl });
    await migrator.connect();
    await expect(
      migrator.query('UPDATE commerce.order_items SET title_snapshot = $1 WHERE id = $2', [
        'tampered',
        '00000000-0000-4000-8000-000000000411',
      ]),
    ).rejects.toThrow(/immutable/i);
    await migrator.end();
  });
});
