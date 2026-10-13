import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout, reviewPath } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { reviewRoundsPath, type ReviewRound } from '../../src/quality/repair.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { readUpstreamSummary, suggestCandidateAction } from '../../src/workflow/navigation.js';
import { authorizeRepair } from '../../src/workflow/repair-entry.js';

/**
 * **A diagnostic about history must not route a repair the current ladder does not admit.**
 *
 * Measured, on `a-repair-revalidates-the-evidence-it-moved`: a current revision, a passing ledger, no blocking and no major
 * finding — and a historical `instrument-unsound` class recurrence. `suggestCandidateAction('review', …)` answered
 * `/kata-build` with reason `review_class_recurring`, and `kata-cli build` then refused with "Build cannot run from review
 * without a problem the strict ladder blocks on … and none has been disposed of". The task could not go forward to the
 * review that would decide whether the recurrence was resolved, and could not go into the repair it was sent to.
 *
 * The branch only ever changed the outcome in exactly the state where its destination is unreachable: when the ladder *does*
 * block, the blocking/major branches below it already route to the same place. So the recurrence reading stays a report, and
 * the route is decided by the ladder it sits above.
 */
const taskId = 'a-recurrence-report-does-not-override-the-ladder';
const roots: string[] = [];

/** Two rounds of one mechanizable class, the second a defect in the first round's repair: the stop-line shape. */
const recyclingRounds: ReviewRound[] = [
    { at: '1', blockingIds: ['A-1'], blockingCount: 1, findings: [{ id: 'A-1', severity: 'major', class: 'instrument-unsound', origin: 'original' }] },
    { at: '2', blockingIds: ['B-1'], blockingCount: 1, findings: [{ id: 'B-1', severity: 'major', class: 'instrument-unsound', origin: 'repair' }] },
];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Fixture {
    root: string;
    summary: Awaited<ReturnType<typeof readUpstreamSummary>>;
    revisionId: string;
    manifestHash: string;
}

async function fixtureWith(
    options: { reviewRecord?: 'pending-clean' | 'approved-clean' | 'blocking-finding'; rounds?: ReviewRound[] } = {},
): Promise<Fixture> {
    const root = await mkdtemp(join(tmpdir(), 'kata-recurrence-route-'));
    roots.push(root);
    await initLayout(root);
    await writeFile(join(root, 'subject.ts'), 'export const subject = true;\n');
    await createTask({
        root,
        id: taskId,
        title: 'A recurrence report does not override the ladder',
        acceptance: [{ id: 'AC-1', statement: 'The route follows the ladder.' }],
        ownedPaths: ['subject.ts'],
        workflowProfile: { version: 1, isolationMode: 'current_worktree', developmentMode: 'tdd', reviewMode: 'strict', comet: { projectInit: 'not_requested', openStatus: 'acknowledged' } },
    });
    const sealed = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: ['test'] });
    await writeFile(
        join(root, '.kata', 'evidence', `${taskId}-current.json`),
        `${JSON.stringify({ taskId, kind: 'test', exitCode: 0, revisionId: sealed.revision.id })}\n`,
    );
    await writeFile(reviewRoundsPath(root, taskId), `${(options.rounds ?? recyclingRounds).map((entry) => JSON.stringify(entry)).join('\n')}\n`);

    const binding = { revisionId: sealed.revision.id, manifestHash: sealed.revision.manifestHash };
    if ((options.reviewRecord ?? 'pending-clean') === 'pending-clean') {
        // The measured shape: a round is recorded for this revision and found nothing at the bar.
        await writeFile(reviewPath(root, taskId), `${JSON.stringify({ ...binding, status: 'pending', findings: [] })}\n`);
    }
    if (options.reviewRecord === 'approved-clean') {
        await writeFile(reviewPath(root, taskId), `${JSON.stringify({ ...binding, status: 'approved', reviewEvidence: 'the round read the change and found nothing at the bar', findings: [] })}\n`);
    }
    if (options.reviewRecord === 'blocking-finding') {
        // A finding bound to the sealed revision: the state where the ladder does admit a repair.
        await writeFile(reviewPath(root, taskId), `${JSON.stringify({ ...binding, status: 'pending', findings: [{ id: 'C-1', taskId, severity: 'blocking', message: 'the current content is wrong', falsifies: 'the route admits a repair here' }] })}\n`);
    }
    return { root, summary: await readUpstreamSummary(root, taskId), revisionId: binding.revisionId, manifestHash: binding.manifestHash };
}

describe('a recurrence report does not override the ladder', () => {
    it('AC-1: keeps the recurring class visible while the ladder has nothing to repair', async () => {
        const { summary } = await fixtureWith();

        // The report half is untouched: the class, its oracle and its repair origin are still published.
        expect(summary.reviewLoopClassRecurrence).toEqual([
            expect.objectContaining({ class: 'instrument-unsound', oracle: 'mechanizable', repairOrigin: 1, stopLineCandidate: true }),
        ]);
        // And the ladder genuinely has nothing: this is the state whose destination used to be unreachable.
        expect(summary.blockingFindings).toBe(0);
        expect(summary.majorFindings).toBe(0);

        const action = suggestCandidateAction('review', summary);
        expect(action.reason, JSON.stringify(action)).not.toBe('review_class_recurring');
        expect(action.nextSkill).not.toBe('/kata-build');
    });

    it('AC-2: sends that state to one fresh review instead of to a repair it cannot enter', async () => {
        const { summary } = await fixtureWith();

        const action = suggestCandidateAction('review', summary);
        expect(action).toMatchObject({ nextSkill: '/kata-review', role: 'reviewer', reason: 'complete_review_conclusion' });
    });

    it('AC-3: lets a clean current review reach the judge rather than looping on history', async () => {
        const { summary } = await fixtureWith({ reviewRecord: 'approved-clean' });
        expect(summary.reviewReady).toBe(true);
        expect(summary.reviewLoopClassRecurrence?.some((entry) => entry.stopLineCandidate)).toBe(true);

        const action = suggestCandidateAction('review', summary);
        expect(action).toMatchObject({ nextSkill: '/kata-judge', role: 'judge' });
    });

    it('AC-4: still speaks where the ladder admits a repair, and the repair entry agrees with it', async () => {
        // The control: with a blocking finding bound to the current revision the same diagnostic still routes, because the
        // repair it names is one Build admits. Deleting the route outright would fail here.
        const admitting = await fixtureWith({ reviewRecord: 'blocking-finding' });
        expect(admitting.summary.blockingFindings).toBeGreaterThan(0);
        expect(suggestCandidateAction('review', admitting.summary)).toMatchObject({ nextSkill: '/kata-build', reason: 'review_class_recurring' });

        // And the refusal the router now agrees with: in the state with nothing at the bar, the repair entry refuses.
        const refusing = await fixtureWith();
        const authorization = await authorizeRepair('review', refusing.root, taskId);
        expect(authorization.authorized, authorization.denial).toBe(false);
        expect(authorization.denial ?? '').toContain('none has been disposed of');
    });

    it('AC-4: the id reading is one instance of the same rule, not a second route', async () => {
        // The sibling branch reads a finding *id* recurring across revisions rather than a class recurring inside a repair, and
        // it had the same shape: it routed to a repair the ladder did not admit. Fixing one and leaving the other is how a class
        // comes back in the next round, so both are asserted against the same state.
        const recurringIds = [
            { at: '1', revisionId: 'rev-a', blockingIds: ['F-1'], blockingCount: 1 },
            { at: '2', revisionId: 'rev-b', blockingIds: ['F-1'], blockingCount: 1 },
        ];
        const { summary } = await fixtureWith({ rounds: recurringIds });
        expect(summary.reviewLoopRecurrence, 'the id reading must be live for this case to mean anything').toEqual([{ id: 'F-1', revisions: ['rev-a', 'rev-b'] }]);
        expect(summary.blockingFindings).toBe(0);

        const action = suggestCandidateAction('review', summary);
        expect(action.reason).not.toBe('review_loop_recurring');
        expect(action.nextSkill).not.toBe('/kata-build');
    });
});
