import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
    ASSURANCE_LEVELS,
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
    subjectRevision: 'rev:0123456789abcdef',
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
        expect(policySchema.properties.tiers.properties.standard?.properties.assuranceFloor.enum.sort())
            .toEqual([...ASSURANCE_LEVELS].sort());
    });
});
