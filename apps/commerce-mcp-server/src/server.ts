import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  LATEST_PROTOCOL_VERSION,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import {
  AccessTokenError,
  AUDIENCES,
  bearerToken,
  normalizeCorrelationId,
  verifyAccessToken,
  type HealthReport,
  type Jwks,
  type VerifiedIdentity,
} from '@commerce/contracts';
import { createDb, createPool, isDomainError, resolveActor, type DomainDb } from '@commerce/domain';
import { TOOL_DEFINITIONS, invokeTool, type ToolResult } from '@commerce/tools';

/**
 * Protocol revision this server is built and tested against: the latest one of the pinned SDK
 * (@modelcontextprotocol/sdk 1.31.0). Older revisions the SDK negotiates remain accepted.
 */
export const MCP_PROTOCOL = LATEST_PROTOCOL_VERSION;
export const MCP_SDK_VERSION = '1.31.0';
const MAX_BODY_BYTES = 64 * 1024;

export interface McpAuthConfig {
  readonly issuer: string;
  readonly jwks: Jwks;
}

export interface McpServerOptions {
  /** Browser origins allowed to call /mcp; requests carrying any other Origin are refused. */
  readonly allowedOrigins?: readonly string[];
}

export function createMcpServer(
  version: string,
  databaseUrl?: string,
  auth?: McpAuthConfig,
  options: McpServerOptions = {},
): Server {
  const pool = databaseUrl ? createPool(databaseUrl) : undefined;
  const db = pool ? createDb(pool) : undefined;
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && (path === '/healthz' || path === '/readyz')) {
      writeHealth(res, version, path === '/readyz' && !db ? 'unavailable' : 'ok');
      return;
    }
    if (path === '/mcp') {
      handleMcp(req, res, version, db, auth, options).catch(() => {
        if (!res.headersSent) writeJsonRpcError(res, 500, -32603, 'internal error');
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"status":"not_found"}');
  });
  server.on('close', () => {
    void db?.destroy();
  });
  return server;
}

function writeHealth(res: ServerResponse, version: string, status: HealthReport['status']): void {
  const body: HealthReport = {
    status,
    service: 'commerce-mcp-server',
    version,
    observed_at: new Date().toISOString(),
    checks: [],
  };
  res.writeHead(status === 'ok' ? 200 : 503, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function writeJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  res
    .writeHead(status, { 'content-type': 'application/json', ...headers })
    .end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new RangeError('body too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

/**
 * Stateless Streamable HTTP: every POST is authenticated, then served by a fresh SDK server bound
 * to that identity. Subject and tenant come only from the verified token; the role comes from
 * the membership row, re-read on every tool call so revocation applies immediately.
 */
async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  version: string,
  db: DomainDb | undefined,
  auth: McpAuthConfig | undefined,
  options: McpServerOptions,
): Promise<void> {
  const origin = req.headers.origin;
  if (origin !== undefined && !(options.allowedOrigins ?? []).includes(origin)) {
    writeJsonRpcError(res, 403, -32003, 'origin not allowed');
    return;
  }
  if (req.method !== 'POST') {
    writeJsonRpcError(res, 405, -32000, 'only POST is supported (stateless server)', {
      allow: 'POST',
    });
    return;
  }
  const identity = authenticate(req, auth);
  if (!identity) {
    writeJsonRpcError(res, 401, -32001, 'authentication required', {
      'www-authenticate': 'Bearer realm="commerce-mcp"',
    });
    return;
  }
  let body: unknown;
  try {
    body = await readBody(req);
  } catch (error) {
    if (error instanceof RangeError) writeJsonRpcError(res, 413, -32600, 'request too large');
    else writeJsonRpcError(res, 400, -32700, 'parse error');
    return;
  }
  const correlationId = normalizeCorrelationId(
    headerValue(req.headers['x-correlation-id']),
    randomUUID,
  ).id;
  // Tools are served from the canonical JSON Schemas, so the low-level request handlers of the
  // underlying protocol server are used instead of McpServer's zod-based registration.
  const mcp = new McpServer(
    { name: 'commerce-mcp-server', version },
    { capabilities: { tools: { listChanged: false } } },
  );
  const protocol = mcp.server;
  protocol.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as { type: 'object' },
      // Hints for clients only. The server never reads them back: authorization below is the same
      // whether or not a client honours them.
      annotations: {
        readOnlyHint: tool.classification === 'READ',
        destructiveHint: tool.classification === 'PRIVILEGED',
        idempotentHint: tool.classification !== 'READ',
        openWorldHint: false,
      },
      _meta: { classification: tool.classification },
    })),
  }));
  protocol.setRequestHandler(CallToolRequestSchema, async (request) =>
    toCallToolResult(await callTool(db, identity, correlationId, request.params)),
  );
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void mcp.close();
  });
  res.setHeader('x-correlation-id', correlationId);
  await mcp.connect(transport);
  await transport.handleRequest(req, res, body);
}

async function callTool(
  db: DomainDb | undefined,
  identity: VerifiedIdentity,
  correlationId: string,
  params: { name: string; arguments?: Record<string, unknown> },
): Promise<ToolResult | { ok: false; error: { code: string; message: string } }> {
  if (!db) {
    return {
      ok: false,
      error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'DATABASE_URL is not configured' },
    };
  }
  try {
    const ctx = await resolveActor(db, {
      tenantId: identity.tenantId,
      subjectId: identity.subject,
      correlationId,
    });
    // MCP clients must hold explicit scopes; a token without `scope` grants no tool.
    return await invokeTool(db, ctx, {
      name: params.name,
      args: params.arguments ?? {},
      clientScopes: identity.scopes ?? [],
    });
  } catch (error) {
    if (isDomainError(error)) {
      return { ok: false, error: { code: error.code, message: error.message } };
    }
    return { ok: false, error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'Tool call failed' } };
  }
}

function toCallToolResult(
  result: ToolResult | { ok: false; error: { code: string; message: string } },
): CallToolResult {
  const structured: Record<string, unknown> = result.ok
    ? { data: result.data, meta: result.meta }
    : { error: result.error, ...('meta' in result ? { meta: result.meta } : {}) };
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError: !result.ok,
  };
}

/** Subject and tenant come only from a verified token issued for the MCP audience. */
function authenticate(
  req: IncomingMessage,
  auth: McpAuthConfig | undefined,
): VerifiedIdentity | undefined {
  const token = bearerToken(req.headers.authorization);
  if (!token || !auth) return undefined;
  try {
    return verifyAccessToken(token, { ...auth, audience: AUDIENCES.mcp });
  } catch (error) {
    if (error instanceof AccessTokenError) return undefined;
    throw error;
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
