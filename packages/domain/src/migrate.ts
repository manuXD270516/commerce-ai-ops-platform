import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export interface MigrateUrls {
  readonly adminUrl: string;
  readonly migratorUrl: string;
  readonly runtimeUrl: string;
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate(urls: MigrateUrls): Promise<readonly string[]> {
  await ensureRoles(urls);
  const client = new pg.Client({ connectionString: urls.migratorUrl });
  await client.connect();
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS commerce');
    await client.query(`
      CREATE TABLE IF NOT EXISTS commerce.schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const applied = new Set(
      (await client.query<{ id: string }>('SELECT id FROM commerce.schema_migrations')).rows.map(
        (r) => r.id,
      ),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const ran: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO commerce.schema_migrations (id) VALUES ($1)', [file]);
        await client.query('COMMIT');
        ran.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return ran;
  } finally {
    await client.end();
  }
}

async function ensureRoles(urls: MigrateUrls): Promise<void> {
  const migrator = new URL(urls.migratorUrl);
  const runtime = new URL(urls.runtimeUrl);
  const admin = new pg.Client({ connectionString: urls.adminUrl });
  await admin.connect();
  try {
    await admin.query('CREATE EXTENSION IF NOT EXISTS vector');
    await admin.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await upsertRole(admin, migrator);
    await upsertRole(admin, runtime);
    // Only when needed: managed services (Azure Flexible Server) give a non-superuser admin that
    // cannot touch the BYPASSRLS attribute, and new roles already lack it.
    const bypass = await admin.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'commerce_runtime'",
    );
    if (bypass.rows[0]?.rolbypassrls) await admin.query('ALTER ROLE commerce_runtime NOBYPASSRLS');
    await admin.query('CREATE SCHEMA IF NOT EXISTS commerce AUTHORIZATION commerce_migrator');
    await admin.query('ALTER SCHEMA commerce OWNER TO commerce_migrator');
    const database = decodeURIComponent(new URL(urls.adminUrl).pathname.replace(/^\//, ''));
    await admin.query(
      `GRANT CONNECT, CREATE, TEMP ON DATABASE ${quoteIdent(database)} TO commerce_migrator`,
    );
    await admin.query(`GRANT CONNECT ON DATABASE ${quoteIdent(database)} TO commerce_runtime`);
  } finally {
    await admin.end();
  }
}

async function upsertRole(admin: pg.Client, url: URL): Promise<void> {
  const name = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const exists = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
  if (exists.rowCount === 0) {
    await admin.query(`CREATE ROLE ${quoteIdent(name)} LOGIN PASSWORD ${quoteLiteral(password)}`);
  } else {
    await admin.query(`ALTER ROLE ${quoteIdent(name)} LOGIN PASSWORD ${quoteLiteral(password)}`);
  }
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteIdent(ident: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(ident)) throw new Error(`invalid identifier ${ident}`);
  return ident;
}
