import { isSpanContextValid, trace } from '@opentelemetry/api';
import { pino, type DestinationStream, type Logger } from 'pino';
import type { HealthReport } from '@commerce/contracts';
import { getCorrelationId } from './context.js';

export type ServiceName = HealthReport['service'];

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.secret',
  '*.authorization',
];

export interface LoggerOptions {
  readonly service: ServiceName;
  readonly level?: string;
  readonly destination?: DestinationStream;
}

/**
 * JSON logger shared by all processes. Every line carries service, correlation_id (when inside
 * runWithCorrelation) and trace/span ids of the active OpenTelemetry span.
 */
export function createLogger(options: LoggerOptions): Logger {
  return pino(
    {
      level: options.level ?? process.env.LOG_LEVEL ?? 'info',
      base: { service: options.service, env: process.env.NODE_ENV ?? 'development' },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
      mixin(_mergeObject, _level, logger) {
        const fields: Record<string, string> = {};
        const correlationId = getCorrelationId();
        if (correlationId && !('correlation_id' in logger.bindings())) {
          fields.correlation_id = correlationId;
        }
        const spanContext = trace.getActiveSpan()?.spanContext();
        if (spanContext && isSpanContextValid(spanContext)) {
          fields.trace_id = spanContext.traceId;
          fields.span_id = spanContext.spanId;
        }
        return fields;
      },
    },
    options.destination,
  );
}
