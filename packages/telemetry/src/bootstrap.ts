import { register } from 'node:module';
import { startTracing, type TracingHandle } from './tracing.js';

export { shutdownTracing } from './tracing.js';

/**
 * Call from a per-app preload (`node --import ./dist/instrumentation.js dist/main.js`). The ESM
 * loader hook must be registered before the application graph is imported so instrumentations
 * can patch ESM imports of node:http.
 */
export function bootstrapTelemetry(serviceName: string): TracingHandle {
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
  return startTracing({ serviceName });
}
