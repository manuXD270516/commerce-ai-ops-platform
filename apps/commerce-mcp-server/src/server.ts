import type { Server } from 'node:http';
import { createHealthServer } from '@commerce/telemetry';

/**
 * M0 skeleton: only liveness/readiness. The MCP endpoint, its authenticated Streamable HTTP
 * transport and the eight tools arrive in M5 (task 6.1), together with the pinned protocol
 * version. Every other path, including /mcp, answers 404 so no unauthenticated MCP surface
 * exists in the meantime.
 */
export function createMcpServer(version: string): Server {
  return createHealthServer({
    service: 'commerce-mcp-server',
    version,
    readiness: () => Promise.resolve([]),
  });
}
