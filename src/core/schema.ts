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
import scopeChangesSchema from 'kata-asset:schemas/scope-changes.schema.json';
import revisionSchema from 'kata-asset:schemas/revision.schema.json';
import userChoiceGateSchema from 'kata-asset:schemas/user-choice-gate.schema.json';
import taskChoiceSchema from 'kata-asset:schemas/task-choice.schema.json';
import reviewSchema from 'kata-asset:schemas/review.schema.json';
import verifyResultSchema from 'kata-asset:schemas/verify-result.schema.json';
import kataRelationsSchema from 'kata-asset:schemas/kata-relations.schema.json';
import changeRecordSchema from 'kata-asset:schemas/change-record.schema.json';
import reviewSubjectSchema from 'kata-asset:schemas/review-subject.schema.json';
import reviewClaimSchema from 'kata-asset:schemas/review-claim.schema.json';
import reviewEvidenceSchema from 'kata-asset:schemas/review-evidence.schema.json';
import reviewEvidenceVerdictSchema from 'kata-asset:schemas/review-evidence-verdict.schema.json';
import reviewDecisionSchema from 'kata-asset:schemas/review-decision.schema.json';
import reviewPolicySchema from 'kata-asset:schemas/review-policy.schema.json';
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
  'scope-changes': scopeChangesSchema,
  revision: revisionSchema,
  'user-choice-gate': userChoiceGateSchema,
    'task-choice': taskChoiceSchema,
  review: reviewSchema,
  'verify-result': verifyResultSchema,
  'kata-relations': kataRelationsSchema,
  'change-record': changeRecordSchema,
  'review-subject': reviewSubjectSchema,
  'review-claim': reviewClaimSchema,
  'review-evidence': reviewEvidenceSchema,
  'review-evidence-verdict': reviewEvidenceVerdictSchema,
  'review-decision': reviewDecisionSchema,
  'review-policy': reviewPolicySchema,
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

/**
 * Every bundled schema is registered by its `$id` **before anything is compiled**, so a schema may `$ref` another instead of
 * restating it.
 *
 * **One definition is the point.** `review.schema.json`'s `findings.items` and `review-finding.schema.json` disagreed — the
 * writer validated the array it read back against the narrower one while the file carried a `disposition` — and a single
 * routed finding made `findings add` fail permanently, so the change could not record a finding at all.
 *
 * Registering here rather than lazily in `compile` is what makes it safe: Ajv raises "schema with key or id already exists"
 * for a duplicate `addSchema`, and `getSchema` does not report a document that was compiled as a root, so a guard by lookup
 * still let the second registration through.
 */
for (const bundled of Object.values(schemaText)) {
    const parsed = JSON.parse(bundled) as { $id?: string };
    if (!parsed.$id) continue;
    // Idempotent by construction: Ajv's own duplicate guard is unreliable here — `getSchema` does not report a document that
    // was compiled as a root, and the same module can be evaluated more than once in a test process.
    try {
        ajv.addSchema(parsed);
    } catch {
        // Already registered: the `$id` is present either way, which is all a `$ref` needs.
    }
}

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
    const document = JSON.parse(text) as { $id?: string };
    // **Compile by `$id`, not by the freshly parsed object.** Every bundled schema is registered at module init so a schema
    // may `$ref` another instead of restating it — and Ajv refuses to compile a *different object* carrying the same `$id`
    // ("schema with key or id already exists"). The registered validator is looked up instead, which is also what keeps one
    // definition in one place: `review.schema.json`'s `findings.items` and `review-finding.schema.json` disagreed for
    // exactly this reason, and the disagreement let a single routed finding block `findings add` permanently.
    const validate = document.$id ? ajv.getSchema(document.$id) : undefined;
    if (!validate) throw new Error(`Schema ${schemaName} is not registered by an $id`);
    compiled.set(schemaName, validate);
    return validate;
}

// ── validate() keeps its signature and throws one line, so every caller is untouched ───────────────────────

export function validate<T>(schemaName: string, value: unknown): T {
  const check = compile(schemaName);
  if (check(value)) return value as T;
  const failure = (check.errors ?? [])[0] as ErrorObject;
  // **The structured error travels with the message.** `readValidated` needs to know *where* the violation was to name the
  // fields the failing object accepts, and a rendered string has thrown that away — which is how a nested violation came
  // to be answered with the root object's field list. Attached rather than returned so `validate`'s signature and its
  // single-line throw stay what every existing caller expects.
  throw Object.assign(new Error(renderError(failure)), { validationError: failure });
}

/**
 * Validate an **artefact**, which may be an object or a list of them.
 *
 * The distinction matters because the schemas and the files are not the same unit: `review-claim.schema.json` describes a
 * claim, while `claims.json` holds a list of them. Validating the file with the element's schema would fail on every
 * healthy ledger, which is presumably why nothing did it — so the six ledger schemas were registered, exercised only by a
 * test that loads the JSON and compiles it directly, and enforced by **no code path**: a definition with no consumer, six
 * times over, and six files a writer could fill with anything.
 *
 * A list is validated element by element and the failure names the index, because "claims.json is invalid" is not
 * something an operator can act on.
 */
export function validateArtefact<T>(schemaName: string, value: unknown): T {
  if (!Array.isArray(value)) return validate<T>(schemaName, value);
  value.forEach((element, index) => {
    try {
      validate(schemaName, element);
    } catch (error) {
      // The path inside the element's message is relative to the element, so the index is prefixed here rather than
      // rewritten there: one place knows about the list, and it is this one.
      const detail = (error as Error).message;
      const withIndex = detail.startsWith('$') ? `$[${index}]${detail.slice(1)}` : `$[${index}]: ${detail}`;
      throw new Error(withIndex);
    }
  });
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
    // **Name what is allowed *there*, not what is allowed at the root.** The hint used to come from the root schema's
    // properties whatever the violation, so a task.json carrying `workflowProfile.gitFlow.command` was answered with the
    // task's own field list — an allowed set for an object the reader was not looking at, which is not a remedy. Measured
    // on that exact artefact; the hint is now derived from the subschema the error occurred in.
    const failure = error instanceof Error ? (error as Error & { validationError?: ErrorObject }).validationError : undefined;
    const hint = failure === undefined || failure.schemaPath === undefined ? '' : fieldHint(schemaName, failure);
    throw new Error(`${schemaName} artefact ${path} does not match its schema: ${error instanceof Error ? error.message : String(error)}.${hint}`);
  }
}

/**
 * The fields the failing object accepts, and where that object is.
 *
 * Only two keywords are answered with a field list, because only two make it the remedy: `additionalProperties` ("this key
 * is not allowed" → which keys are) and `required` ("this key is missing" → what the object demands). An `enum`, `type` or
 * `pattern` failure is answered by the value itself and a field list there is noise that reads like advice.
 */
function fieldHint(schemaName: string, error: ErrorObject): string {
    const keyword = error.keyword;
    if (keyword !== 'additionalProperties' && keyword !== 'required') return '';
    const owner = schemaNodeAt(schemaName, error.schemaPath);
    if (owner === null) return '';
    const properties = owner.properties;
    const fields = properties && typeof properties === 'object' ? Object.keys(properties).sort() : [];
    if (fields.length === 0) return '';
    const where = toJsonPath(error.instancePath) || '$';
    return keyword === 'additionalProperties'
        ? ` Fields allowed at ${where}: ${fields.join(', ')}.`
        : ` Fields required at ${where}: ${fields.join(', ')}.`;
}

/**
 * The subschema a violation happened in, found by walking the root document with the error's `schemaPath`.
 *
 * `$ref` is followed through the bundled schema table rather than by dereferencing the document, because the referenced
 * schema is a separate registered document (`review.schema.json` is the only one that refs today, and it will not be the
 * last). A path this walk cannot follow returns `null` and the caller emits no hint — an absent hint is honest, a hint
 * about the wrong object is not.
 */
function schemaNodeAt(schemaName: string, schemaPath: string): { properties?: unknown; [key: string]: unknown } | null {
    /**
     * **Two shapes of `schemaPath`, and the second was the reason the ref case produced no hint.**
     *
     * An inline violation is `#/properties/workflowProfile/properties/gitFlow/additionalProperties`. A violation inside a
     * `$ref`'d schema is `https://kata.dev/schemas/review-finding.schema.json/additionalProperties` — an absolute `$id`
     * followed by the path *within that document*, which also means the id itself must not be split on `/`. Measured on a
     * review.json whose finding carried an extra key.
     */
    let document: Record<string, unknown> | undefined = schemaText[schemaName] === undefined ? undefined : (JSON.parse(schemaText[schemaName] as string) as Record<string, unknown>);
    let rest = schemaPath.replace(/^#\/?/, '');
    // Matched against each schema's **`$id`**, not the table key: the key is `review-finding` and the id is the URL Ajv
    // actually reports. Matching keys was the first version of this and it silently found nothing.
    for (const entry of parsedSchemas()) {
        if (!schemaPath.startsWith(entry.id)) continue;
        document = entry.document;
        rest = schemaPath.slice(entry.id.length).replace(/^\//, '');
        break;
    }
    if (document === undefined) return null;
    // Drop the trailing keyword segment, which names the rule rather than the object the rule applies to.
    const segments = rest.split('/').filter((part) => part !== '').slice(0, -1);
    let node: unknown = document;
    for (const segment of segments) {
        if (Array.isArray(node)) {
            const index = Number.parseInt(segment, 10);
            if (!Number.isSafeInteger(index)) return null;
            node = node[index];
            continue;
        }
        if (node === null || typeof node !== 'object') return null;
        const record = node as Record<string, unknown>;
        // A reference switches documents: the node is `{ $ref: 'https://kata.dev/schemas/x.schema.json' }` and the rest of
        // the path applies inside the referenced document.
        const reference = record.$ref;
        if (typeof reference === 'string') {
            const target = schemaTextForId(reference);
            if (target === undefined) return null;
            node = target;
        }
        if (segment === '$ref') continue;
        node = (node as Record<string, unknown>)[segment];
        if (node === undefined) return null;
    }
    return node !== null && typeof node === 'object' ? (node as { properties?: unknown }) : null;
}

/** The bundled schemas by `$id`, parsed once: both the `$ref` walk and the `schemaPath` walk need them. */
let parsedCache: Array<{ id: string; document: Record<string, unknown> }> | undefined;
function parsedSchemas(): Array<{ id: string; document: Record<string, unknown> }> {
    if (parsedCache === undefined) {
        parsedCache = Object.values(schemaText)
            .map((text) => JSON.parse(text) as Record<string, unknown> & { $id?: string })
            .filter((document): document is Record<string, unknown> & { $id: string } => typeof document.$id === 'string')
            .map((document) => ({ id: document.$id, document }));
    }
    return parsedCache;
}

/** The bundled schema registered under an `$id`, for following a `$ref` without dereferencing the document. */
function schemaTextForId(id: string): Record<string, unknown> | undefined {
    return parsedSchemas().find((entry) => entry.id === id)?.document;
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
