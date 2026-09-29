import { createRequire } from 'node:module';

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly version: string;
  readonly databaseUrl: string | undefined;
  readonly redisUrl: string | undefined;
}

export const API_CONFIG = Symbol('API_CONFIG');

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const port = Number(env.API_PORT ?? 3001);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`API_PORT must be a TCP port, got ${env.API_PORT}`);
  }
  return {
    host: env.API_HOST ?? '127.0.0.1',
    port,
    version: pkg.version,
    databaseUrl: nonEmpty(env.DATABASE_URL),
    redisUrl: nonEmpty(env.REDIS_URL),
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}
