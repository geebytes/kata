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
import repairBatchSchema from 'kata-asset:schemas/repair-batch.schema.json';
import scopeChangesSchema from 'kata-asset:schemas/scope-changes.schema.json';
import revisionSchema from 'kata-asset:schemas/revision.schema.json';
import userChoiceGateSchema from 'kata-asset:schemas/user-choice-gate.schema.json';
import taskChoiceSchema from 'kata-asset:schemas/task-choice.schema.json';
import reviewSchema from 'kata-asset:schemas/review.schema.json';
import verifyResultSchema from 'kata-asset:schemas/verify-result.schema.json';
import kataRelationsSchema from 'kata-asset:schemas/kata-relations.schema.json';
import adversarialReviewSchema from 'kata-asset:schemas/adversarial-review.schema.json';
import { readFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';

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
  'repair-batch': repairBatchSchema,
  'scope-changes': scopeChangesSchema,
  revision: revisionSchema,
  'user-choice-gate': userChoiceGateSchema,
    'task-choice': taskChoiceSchema,
  review: reviewSchema,
  'verify-result': verifyResultSchema,
  'kata-relations': kataRelationsSchema,
  'adversarial-review': adversarialReviewSchema,
};

/**
 * One Ajv instance for the whole process, from the 2020-12 entry point.
 *
 * Every bundled schema declares `https://json-schema.org/draft/2020-12/schema`, so the instance must be the one that
 * carries that meta-schema; a draft-07 instance refuses to compile them. `strict: false` because these schemas predate
 * strict mode and are hand-written data assets. `allErrors` and `verbose` are on so an error can name the path and the
 * allowed set — the two things an operator-facing gate error has to say.
 */
const ajv = new Ajv2020({ allErrors: true, verbose: true, strict: false });

const compiled = new Map<string, ValidateFunction>();

/** `/relations/3/type` → `$.relations[3].type`, with JSON Pointer unescaping. */
function toJsonPath(pointer: string): string {
    if (pointer === '') return '$';
    return '$' + pointer
        .split('/')
        .slice(1)
        .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'))
        .map((segment) => (/^[0-9]+$/.test(segment) ? `[${segment}]` : `.${segment}`))
        .join('');
}

/**
 * One violation, in the wording the existing tests and readers already expect.
 *
 * The strings are not cosmetic: `tests/unit/schema-validation.test.ts` pins them, and an operator-facing gate error
 * that stops naming the offending path and the allowed set is the failure this module exists to avoid. Two keywords
 * the hand-written interpreter silently ignored now render too: `const` and `uniqueItems`.
 */
function renderError(error: ErrorObject): string {
    const path = toJsonPath(error.instancePath);
    const params = error.params as Record<string, unknown>;
    switch (error.keyword) {
        case 'enum':
            return `${path} must be one of ${(params.allowedValues as unknown[]).join(', ')}`;
        case 'const':
            return `${path} must be ${JSON.stringify(params.allowedValue)}`;
        case 'type': {
            const declared = (error.schema as { type?: string | string[] } | undefined)?.type;
            const types = Array.isArray(declared) ? declared.join(' or ') : String(params.type).split(',').join(' or ');
            return `${path} must be ${types}`;
        }
        case 'required':
            return `${path}.${String(params.missingProperty)} is required`;
        case 'additionalProperties':
            return `${path}.${String(params.additionalProperty)} is not allowed`;
        case 'uniqueItems':
            return `${path} must not contain duplicate items`;
        case 'minItems':
            return `${path} must include at least ${String(params.limit)} item(s)`;
        case 'minLength':
            return `${path} must be at least ${String(params.limit)} characters`;
        case 'minimum':
            return `${path} must be >= ${String(params.limit)}`;
        case 'pattern':
            return `${path} must match ${String(params.pattern)}`;
        default:
            return `${path} ${error.message ?? 'is invalid'}`;
    }
}

function compile(schemaName: string): ValidateFunction {
    if (!/^[a-z][a-z0-9-]*$/.test(schemaName)) throw new Error(`Invalid schema name: ${schemaName}`);
    const cached = compiled.get(schemaName);
    if (cached) return cached;
    const text = schemaText[schemaName];
    if (text === undefined) throw new Error(`Unknown schema: ${schemaName}`);
    const validate = ajv.compile(JSON.parse(text) as object);
    compiled.set(schemaName, validate);
    return validate;
}

// ── validate() keeps its signature and throws one line, so every caller is untouched ───────────────────────

export function validate<T>(schemaName: string, value: unknown): T {
  const check = compile(schemaName);
  if (check(value)) return value as T;
  throw new Error(renderError((check.errors ?? [])[0] as ErrorObject));
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
    // Name what IS allowed: an error that says "…is not allowed" without the allowed set leaves the reader (or the
    // agent) to open the bundle and find the schema — the measured cost of the wiki record that blocked every
    // workflow mutation.
    const allowed = allowedTopLevelFields(schemaName);
    const hint = allowed.length > 0 ? ` Allowed fields: ${allowed.join(', ')}.` : '';
    throw new Error(`${schemaName} artefact ${path} does not match its schema: ${error instanceof Error ? error.message : String(error)}.${hint}`);
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

/** The top-level field names a schema accepts, for error messages that name the remedy rather than the symptom. */
function allowedTopLevelFields(schemaName: string): string[] {
    if (!/^[a-z][a-z0-9-]*$/.test(schemaName)) return [];
    const text = schemaText[schemaName];
    if (text === undefined) return [];
    const properties = (JSON.parse(text) as { properties?: unknown }).properties;
    if (!properties || typeof properties !== 'object') return [];
    return Object.keys(properties).sort();
}
