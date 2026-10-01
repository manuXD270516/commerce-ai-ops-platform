import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Jwks } from '@commerce/contracts';

export interface AuthConfig {
  readonly issuer: string;
  readonly jwks: Jwks;
}

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly version: string;
  readonly databaseUrl: string | undefined;
  readonly redisUrl: string | undefined;
  /** queue: BullMQ job for the worker (needs REDIS_URL); inline: run inside the API process. */
  readonly runExecution: 'queue' | 'inline';
  /** Undefined when AUTH_ISSUER/AUTH_JWKS_FILE are unset: every domain endpoint then answers 401. */
  readonly auth: AuthConfig | undefined;
}

export const API_CONFIG = Symbol('API_CONFIG');

const pkg = createRequire(import.meta.url)('../package.json') as { version: string };
const repoRoot = new URL('../../../', import.meta.url);

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
    runExecution: env.RUN_EXECUTION === 'inline' || !nonEmpty(env.REDIS_URL) ? 'inline' : 'queue',
    auth: loadAuth(env),
  };
}

function loadAuth(env: NodeJS.ProcessEnv): AuthConfig | undefined {
  const issuer = nonEmpty(env.AUTH_ISSUER);
  const jwksFile = nonEmpty(env.AUTH_JWKS_FILE);
  if (!issuer || !jwksFile) return undefined;
  const path = isAbsolute(jwksFile) ? jwksFile : fileURLToPath(new URL(jwksFile, repoRoot));
  if (!existsSync(path)) throw new Error(`AUTH_JWKS_FILE not found at ${path}; run pnpm auth:init`);
  return { issuer, jwks: JSON.parse(readFileSync(path, 'utf8')) as Jwks };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}
