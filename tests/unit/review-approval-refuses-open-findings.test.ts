import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendClaim, freezeSubject, writeSubject } from '../../src/store/ledger.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { evaluateReviewClearance } from '../../src/workflow/distill-gates.js';
import { authorizeReviewRepair } from '../../src/workflow/repair-entry.js';
import { readUpstreamSummary, suggestCandidateAction } from '../../src/workflow/navigation.js';
import { appendReviewRound, reviewProgress } from '../../src/quality/repair.js';
import { describeBlockingProblems, isOpenFinding, type MergeBlockingProblem } from '../../src/quality/review-ladder.js';
import { makeClaim } from '../helpers/review.js';

/**
 * The bar a mode has was not readable from the refusal.
 *
 * `review --approve` refused with the ledger's reason codes — `below_strength (C1): …` — which say *that* the ledger does
 * not pass. Which of those reasons the change's own review mode cares about lived nowhere the operator could read: the
 * severity rule was spread over three routers, and the approval path had stopped consulting it altogether. The refusal now
 * names every problem at the mode's bar, using the same ladder the routers read, so the sentence and the routing cannot
 * disagree about what blocks.
 *
 * The one clause of AC-3 that stays out of reach, recorded rather than faked: "a review whose findings are all **below**
 * the bar still approves" has no witness on the ledger route, because the kernel refuses *any* unsupported claim whatever
 * its severity — severity decides how strong the evidence must be, not whether the ledger passes. A below-bar problem
 * therefore still refuses, and this suite pins that instead of pretending otherwise.
 */
let root: string;
const changeId = 'bar-fixture';

async function writeTask(reviewMode: string): Promise<void> {
    await writeFile(
        join(root, '.kata', 'tasks', changeId, 'task.json'),
        `${JSON.stringify({ id: changeId, ownedPaths: ['src/a.ts'], workflowProfile: { reviewMode } }, null, 2)}\n`,
    );
}

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-bar-'));
    await mkdir(join(root, '.kata', 'tasks', changeId), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'holds\n');
    await writeTask('strict');
    await writeFile(
        join(root, '.kata', 'tasks', changeId, 'current-state.json'),
        `${JSON.stringify({ taskId: changeId, phase: 'review', actor: { id: 'test', role: 'reviewer' }, updatedAt: '2026-09-28T00:00:00.000Z' }, null, 2)}\n`,
    );
    // A ledger that is decided and does not pass: one claim, at the severity this suite varies, with no evidence behind it.
    const subject = await freezeSubject({ root, paths: ['src/a.ts'] });
    if (subject.ok) await writeSubject(root, changeId, subject.subject);
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('the refusal names the problems at the mode\'s bar', () => {
    it('names each problem and the bar it was measured against', () => {
        const problems: MergeBlockingProblem[] = [
            { source: 'claim', id: 'C-1', severity: 'blocking', message: 'the first problem' },
            { source: 'claim', id: 'C-2', severity: 'major', message: 'the second problem' },
        ];
        expect(describeBlockingProblems('strict', problems)).toBe(
            'At the strict bar (blocking, major), 2 problem(s) are open: C-1 (blocking): the first problem | C-2 (major): the second problem',
        );
        // Standard's bar holds one severity, and the sentence says so rather than listing the strict one.
        expect(describeBlockingProblems('std', problems)).toContain('At the standard bar (blocking),');
        expect(describeBlockingProblems('security', problems)).toContain('At the security bar (blocking, major),');
    });

    it('adds nothing when no open problem reaches the bar', () => {
        expect(describeBlockingProblems('strict', [])).toBe('');
    });

    it('refuses the approval while a problem at the bar is open, and names it', async () => {
        await appendClaim(root, changeId, makeClaim({ id: 'C-9', severity: 'blocking', evidenceIds: [], dependsOn: ['path:src/a.ts'] }));

        const result = await runCommand('review', changeId, root, {
            approve: true,
            reviewEvidence: 'the ledger does not pass, so this approval must not be recorded',
            confirmHostModel: true,
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain('C-9');
        expect(result.error).toContain('blocking');
        expect(result.error).toContain('At the strict bar (blocking, major)');
        // The same answer the routers read, carried on the refusal rather than recomputed by a reader.
        expect(result.diagnostics?.blockingProblems).toEqual([
            { source: 'claim', id: 'C-9', severity: 'blocking', message: expect.any(String) },
        ]);
    });

    it('names a major problem under strict, and stays silent about it under standard', async () => {
        await appendClaim(root, changeId, makeClaim({ id: 'C-4', severity: 'major', evidenceIds: [], dependsOn: ['path:src/a.ts'] }));

        const strict = await runCommand('review', changeId, root, {
            approve: true,
            reviewEvidence: 'strict blocks on major, so this refusal names it',
            confirmHostModel: true,
        });
        expect(strict.success).toBe(false);
        expect(strict.error).toContain('At the strict bar (blocking, major)');
        expect(strict.error).toContain('C-4 (major)');
        expect(strict.diagnostics?.blockingProblems).toHaveLength(1);

        await writeTask('std');
        const std = await runCommand('review', changeId, root, {
            approve: true,
            reviewEvidence: 'standard blocks on blocking alone, so it names nothing here',
            confirmHostModel: true,
        });
        // **The mode decides what is named, not whether the ledger passes.** Standard's bar holds `blocking` alone, so
        // this problem is below it and the sentence does not claim a strict bar the task does not have. The approval is
        // still refused — by the kernel, which refuses an unsupported claim whatever its severity — and that is the
        // clause of AC-3 this route cannot witness: a below-bar problem does not become approvable.
        expect(std.success).toBe(false);
        expect(std.error).not.toContain('At the standard bar');
        expect(std.error).not.toContain('At the strict bar');
        expect(std.diagnostics?.blockingProblems).toEqual([]);
    });
});

/**
 * The three surfaces that ask "does this block" now ask one reader, and these tests are the counterexamples an
 * independent review reproduced against the version that had each caller assemble the question itself.
 *
 * Measured then (`tmp/repro-c3c4.mts`): with a ledger that passes and an open `blocking` finding in the record, the
 * approval was **granted**, the change was **routed to the judge**, and a repair was **authorised** — while the distill
 * gate refused the very same change. One question, three answers, and the archive resting on none of them.
 */
describe('a recorded finding is not a thing some consumers may ignore', () => {
    async function writeRecord(body: Record<string, unknown>): Promise<void> {
        await writeFile(join(root, '.kata', 'tasks', changeId, 'review.json'), `${JSON.stringify(body, null, 2)}\n`);
    }

    const finding = (extra: Record<string, unknown> = {}) => ({
        id: 'F-1', taskId: changeId, severity: 'blocking', message: 'still open', ...extra,
    });

    it('refuses the approval, refuses the clearance, and authorises the repair — one answer each', async () => {
        await writeRecord({ status: 'approved', reviewEvidence: 'the round concluded so', findings: [finding()] });

        const approval = await runCommand('review', changeId, root, {
            approve: true,
            reviewEvidence: 'this approval must not be recorded while F-1 is open',
            confirmHostModel: true,
        });
        expect(approval.success).toBe(false);
        expect(approval.error).toContain('F-1 (blocking)');
        expect(approval.error).toContain('At the strict bar');
        expect(approval.diagnostics?.blockingProblems).toHaveLength(1);

        const clearance = await evaluateReviewClearance(root, changeId);
        expect(clearance.cleared).toBe(false);
        expect(clearance.reason).toBe('blocking_findings');

        // The repair entry is the one surface that *acts* on it, so it authorises — and it names the same problem.
        const repair = await authorizeReviewRepair(root, changeId);
        expect(repair.authorized).toBe(true);
        expect(repair.repair?.reason).toBe('review_findings');
        expect(repair.repair?.findings?.map((entry) => entry.message)).toContain('still open');
    });

    it('ignores findings recorded against other content', async () => {
        await writeRecord({
            status: 'approved',
            reviewEvidence: 'a round about a revision this change no longer is',
            revisionId: 'revision-that-moved-on',
            manifestHash: 'a-hash-that-moved-on',
            findings: [finding()],
        });

        const approval = await runCommand('review', changeId, root, {
            approve: true,
            reviewEvidence: 'a stale finding is not a finding about this change',
            confirmHostModel: true,
        });
        expect(approval.success).toBe(false);
        // Refused for the ledger's own reasons, not by a finding the record no longer speaks for.
        expect(approval.error).not.toContain('F-1');
    });

    it('does not refuse on a finding that was disposed of', async () => {
        await writeRecord({ status: 'approved', reviewEvidence: 'disposed', findings: [finding({ disposition: 'fixed' })] });

        const approval = await runCommand('review', changeId, root, {
            approve: true,
            reviewEvidence: 'a fixed problem is not an open one',
            confirmHostModel: true,
        });
        expect(approval.success).toBe(false);
        expect(approval.error).not.toContain('F-1');
    });

    it('refuses a record that is not its schema\'s shape, rather than throwing out of the gate', async () => {
        // `taskId` is required on a finding; a record without it is not a record this repository can decide from.
        await writeRecord({ status: 'approved', reviewEvidence: 'malformed', findings: [{ id: 'F-1', severity: 'blocking', message: 'x' }] });

        const approval = await runCommand('review', changeId, root, {
            approve: true,
            reviewEvidence: 'a malformed record decides nothing',
            confirmHostModel: true,
        });
        expect(approval.success).toBe(false);
        expect(approval.error).toContain('cannot be decided');

        // The gate used to let the schema error escape and become an exception; a gate answers, it does not crash.
        const clearance = await evaluateReviewClearance(root, changeId);
        expect(clearance.cleared).toBe(false);
        expect(clearance.reason).toBe('unreadable_review');
        expect(clearance.detail).toBeTruthy();
    });
});

/**
 * The two surfaces the previous round of tests never drove: the **router** and the **repair entry**.
 *
 * An independent review found the fixes incomplete in exactly those two places, and the reason is visible in the tests
 * that were there: every unreadable-record case was driven through the approval and the gate only. A reader can be right
 * and still be ignored — the router *reported* an unreadable record and read it nowhere, and the repair entry opened the
 * file with a validating read of its own before asking the reader, so it threw where the gate refused.
 */
describe('an unreadable record is refused by every surface, including the ones that route', () => {
    const malformed = { status: 'approved', reviewEvidence: 'malformed', findings: [{ id: 'F-1', severity: 'blocking', message: 'x' }] };

    async function writeMalformed(): Promise<void> {
        await writeFile(join(root, '.kata', 'tasks', changeId, 'review.json'), `${JSON.stringify(malformed, null, 2)}\n`);
    }

    it('routes back to the review rather than to the judge', async () => {
        await writeMalformed();

        const upstream = await readUpstreamSummary(root, changeId);
        expect(upstream.reviewRecordUnreadable).toBeTruthy();
        const action = suggestCandidateAction('review', upstream);
        expect(action?.reason).toBe('unreadable_review_record');
        expect(action?.nextSkill).toBe('/kata-review');
        expect(action?.nextSkill).not.toBe('/kata-judge');
    });

    it('refuses the repair entry instead of throwing out of it', async () => {
        await writeMalformed();
        const repair = await authorizeReviewRepair(root, changeId);
        expect(repair.authorized).toBe(false);
        expect(repair.denial).toContain('cannot be read as one');
    });

    it('refuses when the revision the record binds to cannot be read', async () => {
        // A revision file that is not JSON: the record itself is fine, and the binding cannot be established.
        await writeFile(join(root, '.kata', 'tasks', changeId, 'review.json'), `${JSON.stringify({ status: 'approved', reviewEvidence: 'fine' })}\n`);
        await writeFile(join(root, '.kata', 'tasks', changeId, 'current-revision.json'), '{"id": "rev-1", "manif');

        // The gate must answer, not crash: this file used to reach `currentRevisionIdentity` outside a guard.
        const clearance = await evaluateReviewClearance(root, changeId);
        expect(clearance.cleared).toBe(false);
        expect(clearance.reason).toBe('unreadable_review');
        const repair = await authorizeReviewRepair(root, changeId);
        expect(repair.authorized).toBe(false);
        const approval = await runCommand('review', changeId, root, {
            approve: true,
            reviewEvidence: 'cannot be recorded while the binding is unreadable',
            confirmHostModel: true,
        });
        expect(approval.success).toBe(false);
        expect(approval.error).toContain('cannot be decided');
    });

    it('closes a finding only when it was fixed, not when it was deferred, accepted or routed', async () => {
        const cases: Array<[string, boolean]> = [
            ['fixed', true],
            ['deferred', false],
            ['accepted', false],
            ['routed', false],
            ['open', false],
        ];
        for (const [disposition, cleared] of cases) {
            await writeFile(join(root, '.kata', 'tasks', changeId, 'review.json'), `${JSON.stringify({
                status: 'approved',
                reviewEvidence: 'the round concluded so',
                findings: [{ id: 'F-1', taskId: changeId, severity: 'blocking', message: 'x', disposition }],
            })}\n`);
            const clearance = await evaluateReviewClearance(root, changeId);
            expect(clearance.cleared, `${disposition} must ${cleared ? 'clear' : 'refuse'}`).toBe(cleared);
            // The record's own reader agrees with the gate that decides on it: `change-record` calls everything but
            // `fixed` an open finding, and so does the ladder now.
            expect(isOpenFinding({ disposition })).toBe(!cleared);
        }
    });

    it('stops dispatching repairs when the loop history cannot be measured at all', async () => {
        await appendReviewRound(root, changeId, { at: '2026-09-28T00:00:00.000Z', blockingIds: [], blockingCount: null });
        await appendReviewRound(root, changeId, { at: '2026-09-28T01:00:00.000Z', blockingIds: [], blockingCount: null });

        const progress = reviewProgress([{ at: '', blockingIds: [], blockingCount: null }, { at: '', blockingIds: [], blockingCount: null }]);
        expect(progress.unmeasurable).toBe(true);
        expect(progress.escalating).toBe(true);

        const upstream = await readUpstreamSummary(root, changeId);
        expect(upstream.reviewEscalation?.unmeasurable).toBe(true);
        expect(suggestCandidateAction('review', upstream)?.reason).toBe('escalate_review_without_progress');
    });
});
