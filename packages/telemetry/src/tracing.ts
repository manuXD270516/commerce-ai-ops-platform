import type { IncomingMessage } from 'node:http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

export interface TracingOptions {
  readonly serviceName: string;
  readonly serviceVersion?: string;
  /** Test hook: export synchronously to this exporter instead of OTLP. */
  readonly exporter?: SpanExporter;
  /** Register HTTP/undici auto-instrumentation. Next.js instruments its own server. */
  readonly instrument?: boolean;
}

export interface TracingHandle {
  /** True when spans leave the process (OTLP endpoint configured or test exporter). */
  readonly exporting: boolean;
  shutdown(): Promise<void>;
}

const PROBE_PATHS = ['/healthz', '/readyz'];

let active: TracingHandle | undefined;

/**
 * Registers the global tracer provider with W3C trace context propagation. Without
 * OTEL_EXPORTER_OTLP_ENDPOINT spans are still created, so trace ids reach logs and downstream
 * services, but nothing is exported.
 */
export function startTracing(options: TracingOptions): TracingHandle {
  if (active) return active;

  const spanProcessors: SpanProcessor[] = [];
  if (options.exporter) {
    spanProcessors.push(new SimpleSpanProcessor(options.exporter));
  } else if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter()));
  }

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion ?? process.env.npm_package_version ?? '0.0.0',
    }),
    spanProcessors,
  });
  provider.register();

  if (options.instrument ?? true) {
    registerInstrumentations({
      instrumentations: [
        new HttpInstrumentation({
          ignoreIncomingRequestHook: (req: IncomingMessage) =>
            PROBE_PATHS.some((path) => req.url?.startsWith(path) ?? false),
        }),
        new UndiciInstrumentation(),
      ],
    });
  }

  active = {
    exporting: spanProcessors.length > 0,
    shutdown: async () => {
      await provider.shutdown();
      active = undefined;
    },
  };
  return active;
}

/** Flushes pending spans; safe to call when tracing was never started. */
export async function shutdownTracing(): Promise<void> {
  await active?.shutdown();
}
