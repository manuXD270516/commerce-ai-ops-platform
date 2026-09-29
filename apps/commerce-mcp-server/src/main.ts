import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Jwks } from '@commerce/contracts';
import { createLogger, shutdownTracing } from '@commerce/telemetry';
import { createMcpServer, type McpAuthConfig } from './server.js';

const logger = createLogger({ service: 'commerce-mcp-server' });
const version = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
const port = Number(process.env.MCP_PORT ?? 3003);
const host = process.env.MCP_HOST ?? '127.0.0.1';

function loadAuth(): McpAuthConfig | undefined {
  const { AUTH_ISSUER: issuer, AUTH_JWKS_FILE: jwksFile } = process.env;
  if (!issuer || !jwksFile) return undefined;
  const path = isAbsolute(jwksFile)
    ? jwksFile
    : fileURLToPath(new URL(jwksFile, new URL('../../../', import.meta.url)));
  return { issuer, jwks: JSON.parse(readFileSync(path, 'utf8')) as Jwks };
}

const auth = loadAuth();
if (!auth) logger.warn('AUTH_ISSUER/AUTH_JWKS_FILE unset: every MCP call will answer 401');
const server = createMcpServer(version, process.env.DATABASE_URL, auth);
server.listen(port, host, () => {
  logger.info({ host, port, version, protocol: '2025-06-18' }, 'mcp server ready');
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'mcp server stopping');
  server.close();
  await shutdownTracing();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
