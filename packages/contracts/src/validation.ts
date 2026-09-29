import { createRequire } from 'node:module';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

const require = createRequire(import.meta.url);
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

export const SCHEMA_IDS = {
  healthReport: 'https://commerce-ai-ops.local/schemas/health-report.schema.json',
  serviceStatus: 'https://commerce-ai-ops.local/schemas/service-status.schema.json',
} as const;

export type SchemaName = keyof typeof SCHEMA_IDS;

const SCHEMA_FILES: Record<SchemaName, string> = {
  healthReport: '../schemas/health-report.schema.json',
  serviceStatus: '../schemas/service-status.schema.json',
};

export function loadSchema(name: SchemaName): Record<string, unknown> {
  return require(SCHEMA_FILES[name]) as Record<string, unknown>;
}

export function createContractValidator(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  for (const name of Object.keys(SCHEMA_FILES) as SchemaName[]) {
    ajv.addSchema(loadSchema(name));
  }
  return ajv;
}

export function getValidator<T>(ajv: Ajv2020, name: SchemaName): ValidateFunction<T> {
  const validate = ajv.getSchema<T>(SCHEMA_IDS[name]);
  if (!validate) throw new Error(`Schema not registered: ${name}`);
  return validate;
}
