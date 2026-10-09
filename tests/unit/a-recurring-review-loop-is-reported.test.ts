import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { recurrenceAcrossRevisions, reviewRoundsPath, type ReviewRound } from '../../src/quality/repair.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { readUpstreamSummary, suggestCandidateAction } from '../../src/workflow/navigation.js';

/**
 * **AC-2 — a problem that comes back after a repair has to be visible, and it has to be visible across revisions.**
 *
 * `reviewLoop` is scoped to the current revision deliberately: a round about other content is not a reading of this
 * content. But a repair *produces* a new revision — entering review writes a placeholder bound to it — so every round a
 * repair leaves behind is history about something else, and the reading a stuck loop needs is exactly the one that set
 * cannot produce. Measured downstream: eleven rounds, eleven distinct revision ids, one blocking id recorded in every one
 * of them, and the strongest thing the router could say was `no_current_rounds`. The operator of that change had a loop
 * that had been finding the same problem for eleven rounds and a status that said nothing about it.
 *
 * The reading is a report **and** a route, and deliberately not a gate change: what a change has to satisfy to pass is
 * untouched, and the route sits below the escalation so it can only speak where that produced nothing.
 */
const taskId = 'recurring-finding';
const roots: string[] = [];

const round = (at: string, revisionId: string | undefined, blockingIds: string[], reviewedRevisionId?: string): ReviewRound => ({
    at,
    ...(revisionId === undefined ? {} : { revisionId, manifestHash: 'a'.repeat(64) }),
    ...(reviewedRevisionId === undefined ? {} : { reviewedRevisionId }),
    blockingIds,
    blockingCount: blockingIds.length,
});

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('a finding that recurs across revisions is reported', () => {
    it('names the problem and the revisions, and stays silent about one that appeared once', () => {
        const recurring = recurrenceAcrossRevisions([
            round('1', 'rev-a', ['F-1', 'F-2']),
            round('2', 'rev-b', ['F-1']),
            round('3', 'rev-b', ['F-1']),
        ]);

        // One id over two revisions: the problem outlived the repair that was supposed to end it.
        expect(recurring).toEqual([{ id: 'F-1', revisions: ['rev-a', 'rev-b'] }]);
        // `F-2` appeared under one revision only; it is not a recurrence, and reporting it would be a claim about a repair.
        expect(recurring.some((entry) => entry.id === 'F-2')).toBe(false);
    });

    it('counts the revision the round reviewed, so the pointer moving on does not erase the recurrence', () => {
        // A repair re-seals: the round is recorded against the new revision while it reviewed the content it was opened
        // against. Reading `revisionId` alone would collapse these two rounds into one revision and lose the recurrence.
        const recurring = recurrenceAcrossRevisions([
            round('1', 'rev-new-1', ['R2R12-F1'], 'rev-old'),
            round('2', 'rev-new-2', ['R2R12-F1'], 'rev-new-1'),
        ]);

        expect(recurring).toEqual([{ id: 'R2R12-F1', revisions: ['rev-new-1', 'rev-old'] }]);
    });

    it('treats a line that names no revision as its own bucket rather than as agreement', () => {
        // A legacy line cannot say which content it read. It still counts as a place the problem was seen — but it is not
        // the same revision as anything, so two legacy lines are one bucket and one recurrence, not two revisions.
        expect(recurrenceAcrossRevisions([
            round('1', undefined, ['F-9']),
            round('2', undefined, ['F-9']),
        ])).toEqual([]);
        expect(recurrenceAcrossRevisions([
            round('1', undefined, ['F-9']),
            round('2', 'rev-x', ['F-9']),
        ])).toEqual([{ id: 'F-9', revisions: ['rev-x', 'unnamed revision'] }]);
    });

    it('reports nothing when there is nothing to report', () => {
        expect(recurrenceAcrossRevisions([])).toEqual([]);
        expect(recurrenceAcrossRevisions([round('1', 'rev-a', [])])).toEqual([]);
    });
});

describe('the recovery route for a recurring finding', () => {
    async function summaryWith(rounds: ReviewRound[] | ((sealed: { revisionId: string; manifestHash: string }) => ReviewRound[])): Promise<{ summary: Awaited<ReturnType<typeof readUpstreamSummary>>; sealedRevisionId: string; sealedManifestHash: string }> {
        const root = await mkdtemp(join(tmpdir(), 'kata-recurrence-route-'));
        roots.push(root);
        await initLayout(root);
        await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
        await writeFile(join(root, 'subject.ts'), 'export const subject = true;\n');
        await writeFile(join(root, '.kata', 'tasks', taskId, 'task.json'), `${JSON.stringify({
            id: taskId,
            title: 'Recurring finding',
            acceptance: [{ id: 'AC-1', statement: 'x' }],
            ownedPaths: ['subject.ts'],
            workflowProfile: { reviewMode: 'strict' },
        })}\n`);
        const sealed = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: ['test'] });
        await writeFile(join(root, '.kata', 'evidence', `${taskId}-current.json`), `${JSON.stringify({ taskId, kind: 'test', exitCode: 0, revisionId: sealed.revision.id })}\n`);
        const materialized = typeof rounds === 'function' ? rounds({ revisionId: sealed.revision.id, manifestHash: sealed.revision.manifestHash }) : rounds;
        await writeFile(reviewRoundFile(root), materialized.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
        return { summary: await readUpstreamSummary(root, taskId), sealedRevisionId: sealed.revision.id, sealedManifestHash: sealed.revision.manifestHash };
    }
    const reviewRoundFile = (root: string): string => reviewRoundsPath(root, taskId);

    it('routes a recurring finding to implementation, and says the number of problems that recur', async () => {
        const { summary } = await summaryWith([
            round('1', 'rev-a', ['F-1']),
            round('2', 'rev-b', ['F-1', 'F-2']),
            round('3', 'rev-c', ['F-1']),
        ]);

        // The scope of the loop assessment is the current revision, so it has nothing to judge — which is precisely the
        // state that used to be the end of the story.
        expect(summary.reviewLoop).toEqual({ kind: 'no_current_rounds' });
        expect(summary.reviewLoopRecurrence).toEqual([{ id: 'F-1', revisions: ['rev-a', 'rev-b', 'rev-c'] }]);

        const action = suggestCandidateAction('review', summary);
        expect(action).toMatchObject({ nextSkill: '/kata-build', role: 'implementer', reason: 'review_loop_recurring' });
    });

    it('does not displace the escalation, and does not decide anything a gate would', async () => {
        // A stalled current-revision loop keeps its own route: recurrence is a lower-priority reading, by construction.
        // The rounds are bound to the sealed revision here, which is what "this revision's problems are not falling" means
        // — and the same ids recur across several revisions, so both readings are live at once.
        const stalled = await summaryWith((sealed) => [
            round('1', 'rev-a', ['F-1']),
            round('2', 'rev-b', ['F-1']),
            // Bound to the sealed revision, which is what makes them this revision's rounds.
            ...[3, 4, 5, 6].map((index) => ({
                at: String(index),
                revisionId: sealed.revisionId,
                manifestHash: sealed.manifestHash,
                blockingIds: ['F-1'],
                blockingCount: 1,
            })),
        ]);
        const stalledAction = suggestCandidateAction('review', stalled.summary);
        expect(stalledAction.reason, JSON.stringify({ recurrence: stalled.summary.reviewLoopRecurrence, loop: stalled.summary.reviewLoop })).toBe('escalate_review_without_progress');
        expect(stalledAction.priority).toBeGreaterThan(2100);

        // And the recurring route is not a gateway: crossing phases stays the operator's decision at the gates it names.
        const recurring = await summaryWith([round('1', 'rev-a', ['F-1']), round('2', 'rev-b', ['F-1'])]);
        const action = suggestCandidateAction('review', recurring.summary);
        expect(action.reason).toBe('review_loop_recurring');
        expect(action.nextSkill).toBe('/kata-build');
    });

    it('reports `null`, not an empty list, when the round history cannot be read', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-recurrence-unreadable-'));
        roots.push(root);
        await initLayout(root);
        await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
        await writeFile(join(root, 'subject.ts'), 'export const subject = true;\n');
        await writeFile(join(root, '.kata', 'tasks', taskId, 'task.json'), `${JSON.stringify({
            id: taskId, title: 'Recurring finding', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['subject.ts'],
        })}\n`);
        await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: ['test'] });
        await writeFile(reviewRoundsPath(root, taskId), '{"at":"1","blockingIds":[');

        const summary = await readUpstreamSummary(root, taskId);

        // `[]` here would be a claim about a file nobody could read; the unreadable state has its own route.
        expect(summary.reviewLoopRecurrence).toBeNull();
        expect(suggestCandidateAction('review', summary).reason).toBe('repair_unreadable_round_history');
    });
});
