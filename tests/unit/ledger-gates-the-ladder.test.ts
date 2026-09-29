import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendChallenge, appendClaim, appendEvidence, readLedger, recordVerdicts, reviewDir, ensureAssurance, freezeSubject, writeSubject } from '../../src/store/ledger.js';
import { ledgerVerdict } from '../../src/store/verdict.js';
import { readUpstreamSummary, suggestCandidateAction } from '../../src/workflow/navigation.js';
import { makeClaim, makeEvidence, makeVerdict } from '../helpers/review.js';

/**
 * **The ledger decides the ladder's next action, and its absence is a fact rather than a fallback nobody can see.**
 *
 * The wiring is the point of the whole subsystem: evidence that ends in a report nobody acts on is paperwork. Three states
 * are distinguished here, because they mean different things — a ledger that decides and does not pass sends the change to
 * repair with the kernel's own deficits; a ledger that exists and cannot be parsed refuses rather than looking like a
 * change with no ledger; and a change with no ledger at all keeps the route it had before, which is what lets the old path
 * be retired one change at a time instead of all at once.
 */
let root: string;
const changeId = 'ladder-fixture';

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-ladder-'));
    await mkdir(join(root, '.kata', 'tasks', changeId), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'holds\n');
    await writeFile(
        join(root, '.kata', 'tasks', changeId, 'task.json'),
        `${JSON.stringify({ id: changeId, ownedPaths: ['src/a.ts'], workflowProfile: { reviewMode: 'strict' } }, null, 2)}\n`,
    );
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

async function ladderReason(): Promise<string> {
    const summary = await readUpstreamSummary(root, changeId);
    return suggestCandidateAction('review', summary).reason;
}

describe('the ledger gates the ladder', () => {
    it('reports absence as absence, and leaves the round-shaped branches in charge', async () => {
        const summary = await readUpstreamSummary(root, changeId);
        expect(summary.ledger?.state).toBe('absent');
        expect(summary.ledger?.reason).toContain('no ledger has been recorded');
        expect(await ladderReason()).not.toBe('satisfy_ledger_deficits');
    });

    it('sends the change to repair with the kernel\'s deficits when the ledger does not pass', async () => {
        const subject = await freezeSubject({ root, paths: ['src/a.ts'] });
        expect(subject.ok).toBe(true);
        if (!subject.ok) return;
        await writeSubject(root, changeId, subject.subject);
        await appendClaim(root, changeId, makeClaim({ id: 'C1', severity: 'major', evidenceIds: ['E1'], dependsOn: ['path:src/a.ts'] }));

        const verdict = await ledgerVerdict({ root, changeId });
        expect(verdict.kind).toBe('decided');
        if (verdict.kind === 'decided') {
            expect(verdict.decision.verdict).toBe('insufficient');
            expect(verdict.decision.deficits[0]?.claimId).toBe('C1');
        }
        expect(await ladderReason()).toBe('satisfy_ledger_deficits');
    });

    it('stops gating once the ledger passes', async () => {
        const subject = await freezeSubject({ root, paths: ['src/a.ts'] });
        if (!subject.ok) return;
        await writeSubject(root, changeId, subject.subject);
        await ensureAssurance(root, changeId, 'observed');
        // **Every ledger is at least `strict`**, because the policy ceilings the route there and a floor is only as good as
        // its patterns. So this fixture has to satisfy the strict contract: one claim per required risk class, evidence for
        // each, and the discovery floor's one independent challenge on record.
        const classes = ['consistency', 'boundary', 'failure_mode'] as const;
        const verdicts = [];
        for (const [index, riskClass] of classes.entries()) {
            const evidenceId = `E${index + 1}`;
            await appendClaim(root, changeId, makeClaim({ id: `C${index + 1}`, severity: 'major', riskClass, evidenceIds: [evidenceId], dependsOn: ['path:src/a.ts'] }));
            await appendEvidence(root, changeId, makeEvidence({ id: evidenceId, ref: 'src/a.ts', assertion: 'contains:holds' }));
            verdicts.push(makeVerdict({ evidenceId, subjectRevision: subject.subject.revision }));
        }
        await recordVerdicts(root, changeId, verdicts);
        await appendChallenge(root, changeId, {
            id: 'X1', claimId: 'C1', command: 'exit 1', failsOn: subject.subject.revision, state: 'withdrawn',
            at: '2026-09-27T00:00:00.000Z', resolution: { at: '2026-09-27T00:01:00.000Z', observed: 'exit 0 when checked' },
            // **`reproduced` is the fact the floor counts.** The command failed before the fix — that is what makes it a
            // counterexample — and a challenge that never failed on anything no longer satisfies the discovery floor.
            reproduced: true,
        });

        const verdict = await ledgerVerdict({ root, changeId });
        expect(verdict.kind).toBe('decided');
        if (verdict.kind === 'decided') {
            expect(verdict.decision.verdict).toBe('pass');
            // The ceiling is visible in the decision, not only in the policy: this fixture's paths match no `high` rule,
            // and the tier is still `strict`.
            expect(verdict.tier).toBe('strict');
        }
        expect(await ladderReason()).not.toBe('satisfy_ledger_deficits');
    });

    /**
     * **Coverage is still failable, and it is now proportional to what the change reaches.**
     *
     * This case used to assert the opposite: a change touching only `src/quality/**`, carrying one consistency claim, was
     * refused for a missing `boundary` and `failure_mode` claim — because the tier's list was demanded in full whatever
     * the change did. Measured on a real consistency-only repair, that made the change unpassable except by declaring a
     * claim about a failure mode it does not have, and the refusal listed no deficit to close.
     *
     * The defect it originally pinned still holds: coverage must be able to fail. So both halves are asserted here — the
     * unreached classes are no longer demanded, and a class the change *does* reach still is, by name.
     */
    it('demands the classes a change reaches and not the ones it does not', async () => {
        await mkdir(join(root, 'src', 'quality'), { recursive: true });
        await mkdir(join(root, 'src', 'cli'), { recursive: true });
        await writeFile(join(root, 'src', 'quality', 'x.ts'), 'export const x = 1;\n');
        await writeFile(join(root, 'src', 'cli', 'y.ts'), 'export const y = 1;\n');
        await writeFile(
            join(root, '.kata', 'tasks', changeId, 'task.json'),
            `${JSON.stringify({ id: changeId, ownedPaths: ['src/quality/x.ts', 'src/cli/y.ts'], workflowProfile: { reviewMode: 'strict' } }, null, 2)}\n`,
        );
        const subject = await freezeSubject({ root, paths: ['src/quality/x.ts'] });
        if (!subject.ok) return;
        await writeSubject(root, changeId, subject.subject);
        await ensureAssurance(root, changeId, 'observed');
        await appendClaim(root, changeId, makeClaim({ id: 'C1', severity: 'major', evidenceIds: ['E1'], dependsOn: ['path:src/quality/x.ts'] }));
        await appendEvidence(root, changeId, makeEvidence({ id: 'E1', ref: 'src/quality/x.ts', assertion: 'contains:export' }));
        await recordVerdicts(root, changeId, [makeVerdict({ evidenceId: 'E1', subjectRevision: subject.subject.revision })]);

        const verdict = await ledgerVerdict({ root, changeId });
        expect(verdict.kind).toBe('decided');
        if (verdict.kind !== 'decided') return;
        expect(verdict.tier).toBe('strict');
        expect(verdict.decision.verdict).toBe('insufficient');
        const uncovered = verdict.decision.reasons.find((reason) => reason.code === 'uncovered_risk_class');
        // `src/cli/**` is about the boundary, and nothing claims it. `failure_mode` is not reached by either path, so it
        // is not demanded — that is the whole point of the rule.
        expect(uncovered?.detail).toContain('boundary');
        expect(uncovered?.detail).not.toContain('failure_mode');
        // And the refusal carries the deficit an author acts on, rather than nothing.
        expect(verdict.decision.deficits.map((deficit) => deficit.claimId)).toContain('risk_coverage:boundary');
    });

    it('refuses an unreadable ledger instead of reading it as one that was never written', async () => {
        await mkdir(reviewDir(root, changeId), { recursive: true });
        await writeFile(join(reviewDir(root, changeId), 'claims.json'), '{ this is not json');

        const verdict = await ledgerVerdict({ root, changeId });
        expect(verdict.kind).toBe('unreadable');
        if (verdict.kind === 'unreadable') expect(verdict.detail).toContain('claims.json');
        expect((await readLedger(root, changeId)).malformedFiles).toEqual(['claims.json']);
        expect(await ladderReason()).toBe('satisfy_ledger_deficits');
    });
});
