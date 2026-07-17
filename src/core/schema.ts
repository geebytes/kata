import { readFileSync } from 'node:fs';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type Schema = {
  type?: string;
  enum?: Json[];
  required?: string[];
  additionalProperties?: boolean | Schema;
  properties?: Record<string, Schema>;
  items?: Schema;
  pattern?: string;
  minItems?: number;
  minLength?: number;
  minimum?: number;
};

const schemas = new Map<string, Schema>();

export function validate<T>(schemaName: string, value: unknown): T {
  const schema = loadSchema(schemaName);
  assertMatches(schema, value, '$');
  return value as T;
}

function loadSchema(schemaName: string): Schema {
  if (!/^[a-z][a-z0-9-]*$/.test(schemaName)) {
    throw new Error(`Invalid schema name: ${schemaName}`);
  }
  const cached = schemas.get(schemaName);
  if (cached) return cached;

  const schemaUrl = new URL(`../../schemas/${schemaName}.schema.json`, import.meta.url);
  const parsed = JSON.parse(readFileSync(schemaUrl, 'utf8')) as Schema;
  schemas.set(schemaName, parsed);
  return parsed;
}

function assertMatches(schema: Schema, value: unknown, path: string): void {
  if (schema.enum && !schema.enum.some((allowed) => allowed === value)) {
    throw new Error(`${path} must be one of ${schema.enum.join(', ')}`);
  }

  if (schema.type) assertType(schema.type, value, path);

  if (schema.type === 'string' && typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw new Error(`${path} must be at least ${schema.minLength} characters`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      throw new Error(`${path} must match ${schema.pattern}`);
    }
  }

  if (schema.type === 'integer' && typeof value === 'number' && schema.minimum !== undefined) {
    if (value < schema.minimum) throw new Error(`${path} must be >= ${schema.minimum}`);
  }

  if (schema.type === 'array' && Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw new Error(`${path} must include at least ${schema.minItems} item(s)`);
    }
    if (schema.items) {
      value.forEach((item, index) => assertMatches(schema.items as Schema, item, `${path}[${index}]`));
    }
  }

  if (schema.type === 'object' && isRecord(value)) {
    for (const required of schema.required ?? []) {
      if (!(required in value)) throw new Error(`${path}.${required} is required`);
    }

    const properties = schema.properties ?? {};
    for (const [key, childValue] of Object.entries(value)) {
      const childSchema = properties[key];
      if (childSchema) {
        assertMatches(childSchema, childValue, `${path}.${key}`);
        continue;
      }

      if (schema.additionalProperties === false) {
        throw new Error(`${path}.${key} is not allowed`);
      }
      if (typeof schema.additionalProperties === 'object') {
        assertMatches(schema.additionalProperties, childValue, `${path}.${key}`);
      }
    }
  }
}

function assertType(type: string, value: unknown, path: string): void {
  if (type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    return;
  }
  if (type === 'integer') {
    if (!Number.isInteger(value)) throw new Error(`${path} must be an integer`);
    return;
  }
  if (type === 'object') {
    if (!isRecord(value)) throw new Error(`${path} must be an object`);
    return;
  }
  if (typeof value !== type) throw new Error(`${path} must be a ${type}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
