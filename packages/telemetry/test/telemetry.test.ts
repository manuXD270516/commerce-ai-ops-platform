import { Writable } from 'node:stream';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CORRELATION_SPAN_ATTRIBUTE,
  createLogger,
  getCorrelationId,
  runWithCorrelation,
  startTracing,
} from '../src/index.js';

function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      callback();
    },
  });
  return { logger: createLogger({ service: 'api', level: 'info', destination }), lines };
}

const exporter = new InMemorySpanExporter();
const tracing = startTracing({ serviceName: 'telemetry-test', exporter, instrument: false });

afterAll(async () => {
  await tracing.shutdown();
});

describe('structured logger', () => {
  it('adds correlation_id inside runWithCorrelation and omits it outside', () => {
    const { logger, lines } = captureLogger();
    runWithCorrelation('corr-test-0001', () => {
      logger.info('inside');
    });
    logger.info('outside');
    expect(lines[0]).toMatchObject({
      service: 'api',
      correlation_id: 'corr-test-0001',
      msg: 'inside',
    });
    expect(lines[1]).not.toHaveProperty('correlation_id');
    expect(getCorrelationId()).toBeUndefined();
  });

  it('redacts credentials in request headers', () => {
    const { logger, lines } = captureLogger();
    logger.info({ req: { headers: { authorization: 'Bearer abc', cookie: 'sid=1' } } }, 'req');
    expect(JSON.stringify(lines[0])).not.toMatch(/Bearer abc|sid=1/);
  });
});

describe('tracing', () => {
  it('exports spans tagged with the correlation id and logs their trace id', () => {
    const { logger, lines } = captureLogger();
    const tracer = trace.getTracer('test');
    tracer.startActiveSpan('unit-span', (span) => {
      runWithCorrelation('corr-test-0002', () => {
        logger.info('in span');
      });
      span.end();
    });
    const [finished] = exporter.getFinishedSpans();
    expect(tracing.exporting).toBe(true);
    expect(finished?.attributes[CORRELATION_SPAN_ATTRIBUTE]).toBe('corr-test-0002');
    expect(lines[0]).toMatchObject({ trace_id: finished?.spanContext().traceId });
  });
});
