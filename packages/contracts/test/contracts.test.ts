import { describe, expect, it } from 'vitest';
import {
  createContractValidator,
  getValidator,
  normalizeCorrelationId,
  type HealthReport,
  type ServiceStatus,
} from '../src/index.js';

describe('normalizeCorrelationId', () => {
  it('keeps a well-formed client id', () => {
    expect(normalizeCorrelationId('smoke-1234abcd')).toEqual({
      id: 'smoke-1234abcd',
      source: 'client',
    });
  });

  it.each([undefined, null, '', 'short', 'x'.repeat(65), 'bad id with spaces', 'inj\nected-line'])(
    'replaces untrusted value %j',
    (value) => {
      const result = normalizeCorrelationId(value, () => 'generated-0001');
      expect(result).toEqual({ id: 'generated-0001', source: 'generated' });
    },
  );

  it('uses the first value of a repeated header', () => {
    expect(normalizeCorrelationId(['first-value-1', 'second-value']).id).toBe('first-value-1');
  });
});

describe('JSON Schema contracts', () => {
  const ajv = createContractValidator();

  it('accepts a valid ServiceStatus', () => {
    const validate = getValidator<ServiceStatus>(ajv, 'serviceStatus');
    const body: ServiceStatus = {
      service: 'api',
      version: '0.0.0',
      status: 'ok',
      correlation_id: 'smoke-1234abcd',
      observed_at: '2026-09-29T05:00:00.000Z',
    };
    expect(validate(body)).toBe(true);
  });

  it('rejects unknown properties and invalid correlation ids', () => {
    const validate = getValidator(ajv, 'serviceStatus');
    expect(
      validate({
        service: 'api',
        version: '0.0.0',
        status: 'ok',
        correlation_id: 'bad id',
        observed_at: '2026-09-29T05:00:00.000Z',
        tenant_id: 'x',
      }),
    ).toBe(false);
  });

  it('accepts a HealthReport with dependency checks', () => {
    const validate = getValidator<HealthReport>(ajv, 'healthReport');
    const report: HealthReport = {
      status: 'unavailable',
      service: 'api',
      version: '0.0.0',
      observed_at: '2026-09-29T05:00:00.000Z',
      checks: [{ name: 'redis', status: 'down', latency_ms: 12 }],
    };
    expect(validate(report)).toBe(true);
  });
});
