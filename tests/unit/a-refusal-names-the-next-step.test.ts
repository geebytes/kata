import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decide, type DecideInput } from '../../src/kernel/decide.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { approveUserChoiceGate, createUserChoiceGate } from '../../src/workflow/user-choice-gate.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { makeClaim, makeEvidence, makePolicy, makeSubject, makeVerdict } from '../helpers/review.js';

/**
 * **A refusal that does not say what to do next is a dead end, and three of them were.**
 *
 * Measured, all three on real runs:
 *
 *   - `decide` refused a change with `uncovered_risk_class` while its `deficits` list was **empty** — the reader had to
 *     guess the remedy from a message that named none;
 *   - approving a gate whose content had moved said only that it "is not bound to the current revision" — and the
 *     operator's actual next move (the command that rebuilds the gate) appeared nowhere in the output or the docs;
 *   - `evidence_below_strength` reported `strength >= 3 … strongest supported is 0` when the real fact was that every
 *     verdict belonged to a **previous** revision. Reading the message literally sends an author to write a stronger
 *     check, which fixes nothing.
 *
 * The rule these cases pin: every refusal either carries a non-empty deficit list, or names the paths or patterns that
 * produced the conclusion **and** the action it calls for. The shape to avoid is `reasons` non-empty with `deficits`
 * empty, and a remedy that exists only in the reader's head.
 */
const NOW = '2026-09-29T00:00:00.000Z';

function baseline(overrides: Partial<DecideInput> = {}): DecideInput {
    const subject = makeSubject({ 'src/quality/x.ts': 'the ladder' });
    return {
        subject,
        claims: [makeClaim({ riskClass: 'consistency' })],
        evidence: [makeEvidence({})],
        verdicts: [makeVerdict({ subjectRevision: subject.revision })],
        challenges: [],
        policy: makePolicy(),
        tier: 'strict',
        declaredRiskClasses: ['consistency', 'boundary'],
        touchedRiskClasses: ['consistency'],
        assurance: 'observed',
        usage: {},
        discovery: { independentChallenges: 1, verifiedChallenges: 1 },
        ...overrides,
    };
}

describe('a refusal names the next step', () => {
    it('carries a deficit per uncovered risk class instead of refusing with an empty list', () => {
        const result = decide(baseline({
            touchedRiskClasses: ['consistency', 'boundary'],
            riskClassSources: [{ pattern: 'src/cli/**', classes: ['boundary'] }],
        }));
        const uncovered = result.reasons.find((reason) => reason.code === 'uncovered_risk_class');
        expect(uncovered).toBeDefined();
        // The reason names what produced the demand, not only that something is missing.
        expect(uncovered?.detail).toContain('boundary');
        expect(uncovered?.detail).toContain('src/cli/**');
        // And the deficit an author can act on exists.
        expect(result.deficits.map((deficit) => deficit.claimId)).toContain('risk_coverage:boundary');
        expect(result.deficits.find((deficit) => deficit.claimId === 'risk_coverage:boundary')?.need).toContain('boundary');
    });

    it('reports a stale verdict as a stale verdict, not as a strength shortfall', () => {
        const subject = makeSubject({ 'src/quality/x.ts': 'the ladder' });
        const result = decide(baseline({
            subject,
            // Every verdict belongs to an earlier revision, and no reuse was recorded.
            verdicts: [makeVerdict({ subjectRevision: 'rev:previous' })],
        }));
        const codes = result.reasons.map((reason) => reason.code);
        expect(codes).toContain('evidence_stale_subject');
        const strength = result.reasons.find((reason) => reason.code === 'evidence_below_strength');
        // The old message said "major requires strength 3 … strongest supported is 0" and listed the strength as the need,
        // which is not the fact: the evidence is strong enough, it is about other content.
        expect(strength?.detail ?? '').not.toContain('strongest supported is 0');
        expect(result.deficits.find((deficit) => deficit.claimId === 'C1')?.need ?? '').not.toContain('strength >=');
        expect((result.deficits.find((deficit) => deficit.claimId === 'C1')?.need ?? '').length).toBeGreaterThan(0);
    });
});

describe('a gate that no longer speaks for the content says how to rebuild it', () => {
    let root: string;
    const taskId = 'gate-rebuild';

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'kata-gate-'));
        await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
        await writeFile(join(root, 'subject.ts'), 'export const version = 1;\n');
        await writeFile(
            join(root, '.kata', 'tasks', taskId, 'task.json'),
            `${JSON.stringify({ id: taskId, title: 'T', phase: 'review', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['subject.ts'], createdAt: NOW, updatedAt: NOW })}\n`,
        );
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('names the command that rebuilds the gate when the content has moved past it', async () => {
        const sealed = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: [] });
        await createUserChoiceGate({ root, taskId, boundary: 'review_gate' });
        // The gate was answered for one content; the content then moved, so the answer no longer speaks for it.
        await writeFile(join(root, 'subject.ts'), 'export const version = 2;\n');
        await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: [] });

        const refusal = await approveUserChoiceGate({ root, taskId, boundary: 'review_gate', choice: 'continue_current' })
            .catch((error: Error) => error.message);
        expect(String(refusal)).toContain('not bound');
        // The remedy, stated: the command whose success recreates this boundary's gate.
        expect(String(refusal)).toContain('kata-cli verify');
        expect(sealed.revision.id).toBeTruthy();
    });

    it('says the same thing on the other boundaries, with their own rebuilding command', async () => {
        await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: [] });
        await createUserChoiceGate({ root, taskId, boundary: 'judge_gate' });
        await writeFile(join(root, 'subject.ts'), 'export const version = 3;\n');
        await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: [] });

        const refusal = await approveUserChoiceGate({ root, taskId, boundary: 'judge_gate', choice: 'continue_current' })
            .catch((error: Error) => error.message);
        expect(String(refusal)).toContain('kata-cli review');
    });
});

describe('the policy the refusal is judged against is the one on disk', () => {
    it('names the tier the demand belongs to, so the reader can raise it deliberately', async () => {
        const policy = defaultPolicy();
        const result = decide(baseline({
            policy,
            touchedRiskClasses: ['consistency', 'boundary'],
        }));
        const uncovered = result.reasons.find((reason) => reason.code === 'uncovered_risk_class');
        expect(uncovered?.detail).toContain('required at this tier');
        // The policy file itself is readable as a fact rather than asserted: the tier list is where the demand comes from.
        expect(JSON.parse(JSON.stringify(policy)).tiers.strict.requiredRiskClasses).toContain('boundary');
    });
});
