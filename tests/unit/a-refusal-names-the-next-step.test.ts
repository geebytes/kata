import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decide, type DecideInput } from '../../src/kernel/decide.js';
import type { Deficit, Reason } from '../../src/kernel/types.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { approveUserChoiceGate, createUserChoiceGate } from '../../src/workflow/user-choice-gate.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { makeChallenge, makeClaim, makeEvidence, makePolicy, makeSubject, makeVerdict } from '../helpers/review.js';

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

describe('every refusal the kernel can return carries a next step', () => {
    /**
     * **The state table, and the deficit each state's reason must produce.**
     *
     * The previous version asserted `result.deficits.length > 0` — the *decision's* list — so a reason carrying no deficit
     * of its own passed on a sibling's, and an independent reading falsified the claim by measuring exactly that: four
     * refusals returned `reasons` non-empty with `deficits: []` while this case stayed green. The rule is per reason now:
     * every code this table can reach must be named here, and the answer it names must be present in the decision.
     *
     * Three of the nine states were also wrong in a way that mattered: `usage: { spentTokens: … }` is not a field of
     * `BudgetUsage`, so `budget_exhausted` and two others never fired and the walk silently covered six codes while
     * claiming to cover nine. The measured set is asserted below for that reason.
     */
    const ANSWER_FOR: Record<string, (deficits: readonly Deficit[], reason: Reason) => boolean> = {
        // The state's own step, by the id the deficit carries.
        budget_exhausted: (d) => d.some((entry) => entry.claimId === 'budget:exhausted'),
        assurance_below_tier: (d) => d.some((entry) => entry.claimId === 'assurance:tier'),
        same_actor: (d) => d.some((entry) => entry.claimId === 'quorum:same_actor'),
        challenge_open: (d) => d.some((entry) => entry.claimId.startsWith('challenge:')),
        discovery_floor: (d) => d.some((entry) => entry.claimId === 'discovery:independent_challenge'),
        discovery_unverified: (d) => d.some((entry) => entry.claimId === 'discovery:verified_challenge'),
        quorum_missing: (d) => d.some((entry) => entry.claimId === 'quorum:reviewers'),
        quorum_undiversified: (d) => d.some((entry) => entry.claimId === 'quorum:diversity'),
        // The per-claim refusals answer through the claim the reason names, which is what a repair can act on.
        claim_unsupported: (d, reason) => d.some((entry) => entry.claimId === reason.claimId),
        evidence_missing: (d, reason) => d.some((entry) => entry.claimId === reason.claimId),
        evidence_inconclusive: (d, reason) => d.some((entry) => entry.claimId === reason.claimId),
        evidence_stale_subject: (d, reason) => d.some((entry) => entry.claimId === reason.claimId),
        evidence_below_strength: (d, reason) => d.some((entry) => entry.claimId === reason.claimId),
        quorum_disputed: (d, reason) => d.some((entry) => entry.claimId === reason.claimId),
        // **A counterexample's step is in its message**, and the message names what it is about: the claim and the
        // evidence item that no longer holds. That is the AC's second form, and it is asserted as such rather than
        // waived — a reason with neither a deficit nor a naming message fails the case below.
        evidence_refuted: (_d, reason) => /\b(claim|evidence|revision|refut)/i.test(reason.detail),
        dependency_unresolvable: (_d, reason) => /\b(claim|path|depend)/i.test(reason.detail),
    };

    const states: Array<[string, Partial<DecideInput>]> = [
        ['discovery_floor', { discovery: { independentChallenges: 0, verifiedChallenges: 0 } }],
        ['discovery_unverified', { discovery: { independentChallenges: 1, verifiedChallenges: 0 } }],
        ['quorum_disputed', { quorum: { disputedClaimIds: ['C1'], undiversified: false, reviewers: 2 } as never }],
        ['quorum_missing', { tier: 'security' }],
        ['quorum_undiversified', { tier: 'security', quorum: { disputedClaimIds: [], undiversified: true, reviewers: 2, requiredReviewers: 2 } as never }],
        ['claim_unsupported', { claims: [makeClaim({ severity: 'major', evidenceIds: [] })] }],
        ['evidence_missing', { evidence: [makeEvidence({ type: 'executable_falsifier', command: 'true' })] }],
        ['evidence_inconclusive', { verdicts: [makeVerdict({ subjectRevision: 'rev:other' })] }],
        // The real field, measured: `budgetStatus` reads `usage.wallMs` against `policy.budgets.maxWallMs`.
        ['budget_exhausted', { usage: { wallMs: makePolicy().budgets.maxWallMs + 1 } }],
        ['assurance_below_tier', { tier: 'security' }],
        ['same_actor', { actor: 'the-author' }],
        ['challenge_open', { challenges: [makeChallenge({ claimId: 'C1', state: 'open' })] }],
    ];

    it('answers each reason with its own deficit, or with a message naming what produced it', () => {
        const seen: string[] = [];
        const unanswered: string[] = [];
        for (const [name, overrides] of states) {
            const result = decide(baseline(overrides));
            for (const reason of result.reasons) {
                seen.push(reason.code);
                // **No silent skip**: a reason this contract does not name is a refusal nobody wrote an answer for, which is
                // the shape the case exists to forbid — so it fails here rather than being ignored.
                const answer = ANSWER_FOR[reason.code];
                if (!answer) unanswered.push(`${name}: ${reason.code} is not named in the response contract`);
                else if (!answer(result.deficits, reason)) unanswered.push(`${name}: ${reason.code} carries no answer of its own`);
            }
        }
        expect(unanswered, unanswered.join(' | ')).toEqual([]);
        // The reach: measured, not assumed. This list is what the twelve states actually produce.
        expect([...new Set(seen)].sort()).toEqual([
            'assurance_below_tier',
            'budget_exhausted',
            'challenge_open',
            'claim_unsupported',
            'dependency_unresolvable',
            'discovery_floor',
            'discovery_unverified',
            'evidence_below_strength',
            'evidence_stale_subject',
            'quorum_disputed',
            'quorum_missing',
            'quorum_undiversified',
        ]);
    });
});
