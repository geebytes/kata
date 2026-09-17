import taskSchema from 'kata-asset:schemas/task.schema.json';
import workflowStateRecordSchema from 'kata-asset:schemas/workflow-state-record.schema.json';
import workflowStateEventSchema from 'kata-asset:schemas/workflow-state-event.schema.json';
import evidenceSchema from 'kata-asset:schemas/evidence.schema.json';
import reviewFindingSchema from 'kata-asset:schemas/review-finding.schema.json';
import judgeResultSchema from 'kata-asset:schemas/judge-result.schema.json';
import wikiRecordSchema from 'kata-asset:schemas/wiki-record.schema.json';
import handoffPacketSchema from 'kata-asset:schemas/handoff-packet.schema.json';
import handoffReceiptSchema from 'kata-asset:schemas/handoff-receipt.schema.json';
import repairSchema from 'kata-asset:schemas/repair.schema.json';
import repairObligationsSchema from 'kata-asset:schemas/repair-obligations.schema.json';
import revisionSchema from 'kata-asset:schemas/revision.schema.json';
import userChoiceGateSchema from 'kata-asset:schemas/user-choice-gate.schema.json';
import reviewSchema from 'kata-asset:schemas/review.schema.json';
import { readFile } from 'node:fs/promises';

const schemaText: Record<string, string> = {
  task: taskSchema,
  'workflow-state-record': workflowStateRecordSchema,
  'workflow-state-event': workflowStateEventSchema,
  evidence: evidenceSchema,
  'review-finding': reviewFindingSchema,
  'judge-result': judgeResultSchema,
  'wiki-record': wikiRecordSchema,
  'handoff-packet': handoffPacketSchema,
  'handoff-receipt': handoffReceiptSchema,
  repair: repairSchema,
  'repair-obligations': repairObligationsSchema,
  revision: revisionSchema,
  'user-choice-gate': userChoiceGateSchema,
  review: reviewSchema,
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type Schema = {
  type?: string | string[];
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

/**
 * Reads a JSON artefact and validates it against its schema. Every failure names the artefact and the path, so a
 * drifted file is reported where it is read instead of surfacing later as a missing field in a decision.
 */
export async function readValidated<T>(schemaName: string, path: string): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read ${schemaName} artefact ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${schemaName} artefact ${path} is not valid JSON`);
  }

  try {
    return validate<T>(schemaName, parsed);
  } catch (error) {
    throw new Error(`${schemaName} artefact ${path} does not match its schema: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The tolerant variant: an absent artefact is `null`, drift is still an error. Readers that treat "not written yet"
 * as a normal state use this instead of catching everything, so a corrupted file cannot masquerade as absent.
 */
export async function readValidatedOptional<T>(schemaName: string, path: string): Promise<T | null> {
  try {
    return await readValidated<T>(schemaName, path);
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause;
    if (typeof cause === 'object' && cause !== null && (cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function loadSchema(schemaName: string): Schema {
  if (!/^[a-z][a-z0-9-]*$/.test(schemaName)) {
    throw new Error(`Invalid schema name: ${schemaName}`);
  }
  const cached = schemas.get(schemaName);
  if (cached) return cached;

  const text = schemaText[schemaName];
  if (text === undefined) {
    throw new Error(`Unknown schema: ${schemaName}`);
  }
  const parsed = JSON.parse(text) as Schema;
  schemas.set(schemaName, parsed);
  return parsed;
}

function assertMatches(schema: Schema, value: unknown, path: string): void {
  if (schema.enum && !schema.enum.some((allowed) => allowed === value)) {
    throw new Error(`${path} must be one of ${schema.enum.join(', ')}`);
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(type, value))) {
      throw new Error(`${path} must be ${types.join(' or ')}`);
    }
  }

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

function matchesType(type: string, value: unknown): boolean {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'object') return isRecord(value);
  return typeof value === type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
