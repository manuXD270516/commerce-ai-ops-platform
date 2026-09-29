import { createRequire } from 'node:module';
import { createLogger, shutdownTracing } from '@commerce/telemetry';
import { createMcpServer } from './server.js';

const logger = createLogger({ service: 'commerce-mcp-server' });
const version = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
const port = Number(process.env.MCP_PORT ?? 3003);
const host = process.env.MCP_HOST ?? '127.0.0.1';

const server = createMcpServer(version);
server.listen(port, host, () => {
  logger.info({ host, port, version, mcp_endpoint: 'not-exposed-until-M5' }, 'mcp server ready');
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'mcp server stopping');
  server.close();
  await shutdownTracing();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
