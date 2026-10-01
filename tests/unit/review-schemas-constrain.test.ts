import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { validateArtefact } from '../../src/core/schema.js';
import { describe, expect, it } from 'vitest';
import {
    ASSURANCE_LEVELS,
    LEGACY_ASSURANCE_LEVELS,
    READABLE_ASSURANCE_LEVELS,
    EVIDENCE_TYPES,
    REASON_MESSAGES,
    RISK_CLASSES,
    SEVERITIES,
    TIER_NAMES,
    type Claim,
    type Evidence,
} from '../../src/kernel/types.js';

/**
 * **A schema that cannot refuse anything is not a schema.**
 *
 * Two things are checked rather than assumed: every schema refuses a document that breaks it (the same "every check can
 * fail" discipline the verifiers get, applied to the documents), and the enums in the schemas are the *same* enums the
 * kernel uses. That second one is the drift this repository keeps finding — one fact derived in two places, one updated
 * and the other missed — and here the two places are a JSON file and a TypeScript union, which nothing else would keep
 * in step.
 */
const SCHEMA_DIR = join(process.cwd(), 'schemas');
const NAMES = [
    'review-subject.schema.json',
    'review-claim.schema.json',
    'review-evidence.schema.json',
    'review-evidence-verdict.schema.json',
    'review-decision.schema.json',
    'review-policy.schema.json',
];

function load(name: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(SCHEMA_DIR, name), 'utf8')) as Record<string, unknown>;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
for (const name of NAMES) ajv.addSchema(load(name));

function validator(id: string) {
    const validate = ajv.getSchema(id);
    if (!validate) throw new Error(`no schema registered under ${id}`);
    return validate as (value: unknown) => boolean;
}

const claim: Claim = {
    id: 'C1',
    statement: 'the export is present',
    riskClass: 'consistency',
    severity: 'major',
    dependsOn: ['path:src/a.ts'],
    evidenceIds: ['E1'],
    challengeIds: [],
    status: 'open',
    at: '2026-09-27T00:00:00.000Z',
    reopens: 0,
};

const evidence: Evidence = {
    id: 'E1',
    type: 'executable_falsifier',
    command: 'npm run check',
    mutation: { file: 'src/a.ts', find: 'holds', replace: 'broken' },
};

describe('the review schemas constrain their documents', () => {
    it('gives every schema its own id', () => {
        const ids = NAMES.map((name) => load(name).$id);
        expect(new Set(ids).size).toBe(NAMES.length);
        for (const id of ids) expect(String(id)).toMatch(/^https:\/\/kata\.dev\/schemas\//u);
    });

    it('accepts a valid instance and refuses a broken one, for each document', () => {
        expect(validator('https://kata.dev/schemas/review-claim.json')(claim)).toBe(true);
        expect(validator('https://kata.dev/schemas/review-claim.json')({ ...claim, riskClass: 'vibes' })).toBe(false);
        expect(validator('https://kata.dev/schemas/review-claim.json')({ ...claim, severity: 'critical' })).toBe(false);
        expect(validator('https://kata.dev/schemas/review-claim.json')({ ...claim, dependsOn: ['src/a.ts'] })).toBe(false);

        expect(validator('https://kata.dev/schemas/review-evidence.json')(evidence)).toBe(true);
        expect(validator('https://kata.dev/schemas/review-evidence.json')({ ...evidence, mutation: undefined })).toBe(false);
        expect(validator('https://kata.dev/schemas/review-evidence.json')({ ...evidence, extra: 1 })).toBe(false);

        const verdict = {
            evidenceId: 'E1',
            evidenceType: 'executable_falsifier',
            verdict: 'supported',
            observed: '{"before":0,"mutated":1,"after":0}',
            at: '2026-09-27T00:00:00.000Z',
            verifier: 'producers/verifiers#executable-falsifier',
            subjectRevision: 'rev:0123456789abcdef',
        };
        expect(validator('https://kata.dev/schemas/review-evidence-verdict.json')(verdict)).toBe(true);
        expect(validator('https://kata.dev/schemas/review-evidence-verdict.json')({ ...verdict, verdict: 'maybe' })).toBe(false);

        const decision = {
            verdict: 'insufficient',
            riskTier: 'strict',
            reasons: [{ code: 'challenge_open', detail: 'one open counterexample' }],
            reusedEvidence: [],
            revalidateClaims: ['C1'],
            // **A fixture, not a writer.** This case builds a decision by hand — which is why it did not notice that the
            // schema had fallen behind the value: `deltaEvaluated` was added to the real decision and not to the schema, and
            // a hand-written instance cannot drift *from* anything. The case below that validates a decision the kernel
            // actually produced is the one that catches that.
            deltaEvaluated: false,
            deficits: [{ claimId: 'C1', need: 'evidence of strength >= 3' }],
            undiversified: false,
        };
        expect(validator('https://kata.dev/schemas/review-decision.json')(decision)).toBe(true);
        expect(validator('https://kata.dev/schemas/review-decision.json')({ ...decision, verdict: 'passed' })).toBe(false);
        expect(validator('https://kata.dev/schemas/review-decision.json')({ ...decision, reasons: [{ code: 'looks_good', detail: 'x' }] })).toBe(false);

        expect(validator('https://kata.dev/schemas/review-subject.json')({ revision: 'rev:0123456789abcdef', pathDigests: { 'src/a.ts': '0123456789abcdef' } })).toBe(true);
        expect(validator('https://kata.dev/schemas/review-subject.json')({ revision: 'HEAD', pathDigests: {} })).toBe(false);
    });

    it('keeps the schema enums and the kernel enums the same fact', () => {
        const claimSchema = load('review-claim.schema.json') as { properties: Record<string, { enum?: string[] }> };
        expect(claimSchema.properties.riskClass?.enum?.sort()).toEqual([...RISK_CLASSES].sort());
        expect(claimSchema.properties.severity?.enum?.sort()).toEqual([...SEVERITIES].sort());

        const evidenceSchema = load('review-evidence.schema.json') as { oneOf: Array<{ properties: { type: { const: string } } }> };
        expect(evidenceSchema.oneOf.map((entry) => entry.properties.type.const).sort()).toEqual([...EVIDENCE_TYPES].sort());

        const decisionSchema = load('review-decision.schema.json') as {
            properties: { reasons: { items: { properties: { code: { enum: string[] } } } }; riskTier: { enum: string[] } };
        };
        expect(decisionSchema.properties.reasons.items.properties.code.enum.sort()).toEqual(Object.keys(REASON_MESSAGES).sort());
        expect(decisionSchema.properties.riskTier.enum.sort()).toEqual([...TIER_NAMES].sort());

        const policySchema = load('review-policy.schema.json') as {
            properties: { tiers: { properties: Record<string, { properties: { assuranceFloor: { enum: string[] } } }> } };
        };
        // The floor enum is the **write** vocabulary: a historical floor stays readable in the documents that carry it
        // (see `READABLE_ASSURANCE_LEVELS`) but no current schema offers it as a value to write.
        expect(policySchema.properties.tiers.properties.standard?.properties.assuranceFloor.enum.sort())
            .toEqual([...ASSURANCE_LEVELS].sort());

        // **`review.schema.json`'s assurance enum is the READ vocabulary, and that is deliberate.** R8-F6 noticed it still
        // lists the retired values and called the write-side guarantee runtime-only. Narrowing it was tried and reverted in
        // the same round: a narrowed enum makes a *historical* review fail validation, and C-4 requires historical
        // artefacts stay readable — a document that cannot be read is a record destroyed (measured: narrowing it reddened
        // `sandboxed-retirement`'s read case). One enum cannot say "readable here, unwritable there", so this asserts both
        // halves: the schema is the readable set, and the write surface is where the retired values are refused.
        const reviewSchema = load('review.schema.json') as {
            properties: { ledgerReview: { properties: { assurance: { enum: string[] } } } };
        };
        expect(reviewSchema.properties.ledgerReview.properties.assurance.enum.sort())
            .toEqual([...READABLE_ASSURANCE_LEVELS].sort());
        // The other half, asserted where it lives rather than assumed: the write-side refusal is in the ledger CLI, and a
        // historical value reaches a *decision* only through `ledger decide --assurance`, which refuses it by name.
        const legacyReview = {
            revisionId: 'revision-0000000000000000', status: 'approved', findings: [],
            ledgerReview: { subjectRevision: 'rev:0000000000000000', tier: 'security', assurance: 'sandboxed', claims: 1, limits: ['x'] },
        };
        expect(() => validateArtefact('review', legacyReview)).not.toThrow();

        // **No fixture may build a security scenario out of a retired value.** R8-F7: two seeds in
        // `tests/fixtures/review-scenarios.ts` still constructed `assurance: 'sandboxed'`, so the retired value remained the
        // way to *get* a security case — they also started tripping `assurance_below_tier` for a reason unrelated to what
        // they assert. This reads the fixture source, because the point is which value the scenarios are built from.
        const scenarios = readFileSync(join(import.meta.dirname, '..', 'fixtures', 'review-scenarios.ts'), 'utf8');
        for (const retired of LEGACY_ASSURANCE_LEVELS) {
            expect(scenarios, `a scenario is still built from the retired value ${retired}`).not.toContain(`assurance: '${retired}'`);
        }
    });
});
