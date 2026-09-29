import { AsyncLocalStorage } from 'node:async_hooks';
import { trace } from '@opentelemetry/api';

interface CorrelationContext {
  readonly correlationId: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

export const CORRELATION_SPAN_ATTRIBUTE = 'app.correlation_id';

/** Runs fn with the correlation id available to loggers and tags the active span with it. */
export function runWithCorrelation<T>(correlationId: string, fn: () => T): T {
  trace.getActiveSpan()?.setAttribute(CORRELATION_SPAN_ATTRIBUTE, correlationId);
  return storage.run({ correlationId }, fn);
}

export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}
