import type { IncomingMessage, ServerResponse } from 'node:http';
import { CORRELATION_HEADER, normalizeCorrelationId } from '@commerce/contracts';
import { runWithCorrelation } from '@commerce/telemetry';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';

const correlationIds = new WeakMap<IncomingMessage, string>();
const PROBE_PATHS = new Set(['/healthz', '/readyz']);

function pathOf(url: string | undefined): string {
  return (url ?? '/').split('?')[0] ?? '/';
}

export function correlationIdOf(req: IncomingMessage): string {
  const id = correlationIds.get(req);
  if (!id) throw new Error('correlation middleware not installed');
  return id;
}

/**
 * Accepts or generates the correlation id, echoes it in the response, and logs one structured
 * line per request. Only method, path and status are logged: query strings and bodies may carry
 * PII.
 */
export function httpLogging(logger: Logger) {
  const log = pinoHttp({
    logger,
    genReqId: (req) => correlationIdOf(req),
    customAttributeKeys: { reqId: 'correlation_id', responseTime: 'duration_ms' },
    serializers: {
      req: (req: IncomingMessage) => ({ method: req.method, path: pathOf(req.url) }),
      res: (res: ServerResponse) => ({ status_code: res.statusCode }),
    },
    autoLogging: { ignore: (req) => PROBE_PATHS.has(pathOf(req.url)) },
    customSuccessMessage: () => 'request completed',
    customErrorMessage: () => 'request failed',
  });

  return (req: Request, res: Response, next: NextFunction): void => {
    const { id, source } = normalizeCorrelationId(req.headers[CORRELATION_HEADER]);
    correlationIds.set(req, id);
    res.setHeader(CORRELATION_HEADER, id);
    runWithCorrelation(id, () => {
      log(req, res);
      if (source === 'generated' && req.headers[CORRELATION_HEADER] !== undefined) {
        logger.warn({ path: pathOf(req.url) }, 'invalid correlation id replaced');
      }
      next();
    });
  };
}
