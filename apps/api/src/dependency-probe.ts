import type { DependencyCheck } from '@commerce/contracts';
import { Redis } from 'ioredis';
import pg from 'pg';

export const DEPENDENCY_PROBE = Symbol('DEPENDENCY_PROBE');

export interface DependencyProbe {
  check(): Promise<DependencyCheck[]>;
  close(): Promise<void>;
}

const TIMEOUT_MS = 2000;

async function timed(fn: () => Promise<void>): Promise<{ ok: boolean; latency_ms: number }> {
  const started = performance.now();
  const timeout = new Promise<boolean>((resolve) => {
    setTimeout(() => {
      resolve(false);
    }, TIMEOUT_MS).unref();
  });
  const ok = await Promise.race([fn().then(() => true), timeout]).catch(() => false);
  return { ok, latency_ms: Math.round(performance.now() - started) };
}

/**
 * Readiness only: reachability of PostgreSQL and Redis and availability (not installation) of
 * the pgvector extension. No schema access; the vector extension is created by M1 migrations.
 */
export class PostgresRedisProbe implements DependencyProbe {
  private readonly pool: pg.Pool | undefined;

  constructor(
    databaseUrl: string | undefined,
    private readonly redisUrl: string | undefined,
  ) {
    this.pool = databaseUrl
      ? new pg.Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: TIMEOUT_MS })
      : undefined;
    this.pool?.on('error', () => undefined);
  }

  async check(): Promise<DependencyCheck[]> {
    const extension = { vectorAvailable: false };
    const postgres = await timed(async () => {
      if (!this.pool) throw new Error('DATABASE_URL not configured');
      const result = await this.pool.query<{ available: boolean }>(
        "select exists(select 1 from pg_available_extensions where name = 'vector') as available",
      );
      extension.vectorAvailable = result.rows[0]?.available === true;
    });
    const vectorAvailable = extension.vectorAvailable;
    const redis = await timed(() => this.pingRedis());
    return [
      { name: 'postgres', status: postgres.ok ? 'up' : 'down', latency_ms: postgres.latency_ms },
      {
        name: 'pgvector',
        status: vectorAvailable ? 'up' : 'down',
        latency_ms: postgres.latency_ms,
      },
      { name: 'redis', status: redis.ok ? 'up' : 'down', latency_ms: redis.latency_ms },
    ];
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  private async pingRedis(): Promise<void> {
    if (!this.redisUrl) throw new Error('REDIS_URL not configured');
    const client = new Redis(this.redisUrl, {
      lazyConnect: true,
      connectTimeout: TIMEOUT_MS,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    client.on('error', () => undefined);
    try {
      await client.connect();
      await client.ping();
    } finally {
      client.disconnect();
    }
  }
}
