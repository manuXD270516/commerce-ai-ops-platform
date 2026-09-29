import {
  CORRELATION_HEADER,
  createContractValidator,
  getValidator,
  normalizeCorrelationId,
  type ServiceStatus,
} from '@commerce/contracts';
import { createLogger, runWithCorrelation } from '@commerce/telemetry';
import { context, propagation } from '@opentelemetry/api';

const logger = createLogger({ service: 'web' });
const validateStatus = getValidator<ServiceStatus>(createContractValidator(), 'serviceStatus');

export interface ApiStatusOptions {
  readonly apiBaseUrl: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface WebStatusBody {
  readonly service: 'web';
  readonly correlation_id: string;
  readonly status: 'ok' | 'degraded';
  readonly api: ServiceStatus | null;
}

/**
 * Diagnostic hop web → api. Forwards the (validated) correlation id and W3C trace context so
 * both processes log and trace the same request. The API response is validated against its
 * contract before being echoed.
 */
export function checkApiStatus(request: Request, options: ApiStatusOptions): Promise<Response> {
  const { id } = normalizeCorrelationId(request.headers.get(CORRELATION_HEADER));
  const fetchImpl = options.fetchImpl ?? fetch;

  return runWithCorrelation(id, async () => {
    const headers: Record<string, string> = {
      [CORRELATION_HEADER]: id,
      accept: 'application/json',
    };
    propagation.inject(context.active(), headers);
    const started = performance.now();
    let body: WebStatusBody = { service: 'web', correlation_id: id, status: 'degraded', api: null };
    let statusCode = 502;

    try {
      const res = await fetchImpl(`${options.apiBaseUrl}/v1/status`, {
        headers,
        cache: 'no-store',
        signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
      });
      const payload: unknown = await res.json();
      const valid = res.ok && validateStatus(payload);
      logger.info(
        {
          upstream: 'api',
          path: '/v1/status',
          status_code: res.status,
          contract_valid: valid,
          duration_ms: Math.round(performance.now() - started),
        },
        'upstream call completed',
      );
      if (valid) {
        body = { ...body, status: 'ok', api: payload };
        statusCode = 200;
      }
    } catch (error) {
      logger.warn(
        {
          upstream: 'api',
          path: '/v1/status',
          err: error instanceof Error ? error.name : 'unknown',
        },
        'upstream call failed',
      );
    }

    return Response.json(body, { status: statusCode, headers: { [CORRELATION_HEADER]: id } });
  });
}
