import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { recurrenceAcrossRevisions, reviewRoundsPath, type ReviewRound } from '../../src/quality/repair.js';
import { invalidatingStates, type UpstreamSummary } from '../../src/workflow/navigation.js';
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
    async function summaryWith(
        rounds: ReviewRound[] | ((sealed: { revisionId: string; manifestHash: string }) => ReviewRound[]),
        options: { corruptReviewRecord?: boolean; mixedRevisionEvidence?: boolean; verifyFailed?: boolean; corruptLedger?: boolean } = {},
    ): Promise<{ summary: Awaited<ReturnType<typeof readUpstreamSummary>>; sealedRevisionId: string; sealedManifestHash: string; root: string }> {
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
        if (options.mixedRevisionEvidence === true) {
            // Two evidence files bound to different revisions: judged together they prove nothing about either.
            await writeFile(join(root, '.kata', 'evidence', `${taskId}-other.json`), `${JSON.stringify({ taskId, kind: 'test', exitCode: 0, revisionId: 'revision-something-else' })}\n`);
        }
        if (options.verifyFailed === true) {
            // **Bound to the sealed revision**: a verify record from another revision is not evidence about this content, and
            // `onlyCurrentRevision` correctly drops it — which is why the fixture must carry the binding, not just a FAIL.
            await writeFile(join(root, '.kata', 'tasks', taskId, 'verify.json'), `${JSON.stringify({ result: 'FAIL', revisionId: sealed.revision.id, manifestHash: sealed.revision.manifestHash, acceptance: [] })}\n`);
        }
        if (options.corruptLedger === true) {
            await writeFile(join(root, '.kata', 'tasks', taskId, 'review', 'ledger.json'), '{ not a ledger\n');
        }
        if (options.corruptReviewRecord === true) {
            // A record that exists and cannot be read: the state that must be re-read before anything is concluded about it.
            await writeFile(join(root, '.kata', 'tasks', taskId, 'review.json'), '{ this is not a review record\n');
        }
        return { summary: await readUpstreamSummary(root, taskId), sealedRevisionId: sealed.revision.id, sealedManifestHash: sealed.revision.manifestHash, root };
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

    it('routes a class that came back inside a repair, and stays quiet for one that recurred only in the original code', async () => {
        // **The signal the id view cannot see.** No finding id repeats, so `reviewLoopRecurrence` is empty — while the same
        // mechanizable class appears in two rounds and one instance is a defect in the *previous* repair. That is the
        // recycling shape, and publishing it without routing it was the "computed, nobody reads it" defect an independent
        // round measured (R1-F2).
        const recycling = await summaryWith([
            { at: '1', blockingIds: ['A-1'], blockingCount: 1, findings: [{ id: 'A-1', severity: 'major', class: 'instrument-unsound', origin: 'original' }] },
            { at: '2', blockingIds: ['B-1'], blockingCount: 1, findings: [{ id: 'B-1', severity: 'major', class: 'instrument-unsound', origin: 'repair' }] },
        ]);
        expect(recycling.summary.reviewLoopRecurrence).toEqual([]);
        expect(recycling.summary.reviewLoopClassRecurrence).toEqual([
            expect.objectContaining({ class: 'instrument-unsound', oracle: 'mechanizable', repairOrigin: 1, stopLineCandidate: true }),
        ]);
        expect(suggestCandidateAction('review', recycling.summary)).toMatchObject({ nextSkill: '/kata-build', role: 'implementer', reason: 'review_class_recurring' });

        // The control: the same class twice, both in the original code — worth mechanizing, not a stop signal, and it must
        // not displace the routes that the ordinary review readings produce.
        const original = await summaryWith([
            { at: '1', blockingIds: ['A-1'], blockingCount: 1, findings: [{ id: 'A-1', severity: 'major', class: 'instrument-unsound', origin: 'original' }] },
            { at: '2', blockingIds: ['B-1'], blockingCount: 1, findings: [{ id: 'B-1', severity: 'major', class: 'instrument-unsound', origin: 'original' }] },
        ]);
        expect(original.summary.reviewLoopClassRecurrence?.every((entry) => !entry.stopLineCandidate)).toBe(true);
        expect(suggestCandidateAction('review', original.summary).reason).not.toBe('review_class_recurring');
    });

    it('puts every state that invalidates the report above the report', async () => {
        // **The class, not the instance** (R4-F4). Two rounds fixed one branch each; an independent round then found a third
        // (`verifyResult: 'FAIL'`, whose own comment says the findings "were formed against content that no longer stands").
        // This case is table-driven on purpose: the property is "every state that must be repaired before a report about the
        // change means anything wins over the reports", so a fourth state added below them fails here rather than in a round.
        const recurring = [
            { at: '1', blockingIds: ['A-1'], blockingCount: 1, findings: [{ id: 'A-1', severity: 'major', class: 'instrument-unsound', origin: 'original' }] },
            { at: '2', blockingIds: ['B-1'], blockingCount: 1, findings: [{ id: 'B-1', severity: 'major', class: 'instrument-unsound', origin: 'repair' }] },
        ];
        const states: Array<{ what: string; options: { corruptReviewRecord?: boolean; mixedRevisionEvidence?: boolean; verifyFailed?: boolean; corruptLedger?: boolean }; expected: string }> = [
            { what: 'a review record nobody can read', options: { corruptReviewRecord: true }, expected: 'unreadable_review_record' },
            { what: 'evidence from two revisions', options: { mixedRevisionEvidence: true }, expected: 'repair_mixed_revision_evidence' },
            { what: 'a verify that failed against this content', options: { verifyFailed: true }, expected: 'repair_failed_verify' },
        ];
        for (const state of states) {
            const built = await summaryWith(recurring, state.options);
            const action = suggestCandidateAction('review', built.summary);
            // The recurrence is real in every row: the report exists and must lose to the state.
            expect(built.summary.reviewLoopClassRecurrence?.some((entry) => entry.stopLineCandidate), state.what).toBe(true);
            expect(action.reason, `${state.what}: ${JSON.stringify(action)}`).toBe(state.expected);
        }
    });

    it('answers every state that invalidates the report, from one table', async () => {
        // **The class, not the instance — again, and this time with the enumeration asserted.** The rule was fixed four times
        // (one branch per round); the table is the fifth answer, and this case checks the two things a table can get wrong: an
        // entry that does not fire, and a summary field that nobody routed. The second list is written here on purpose: adding
        // an `*Unreadable` field to `UpstreamSummary` without deciding where it routes fails this case, which is the point.
        const recurring = {
            reviewFindings: 1,
            blockingFindings: 1,
            majorFindings: 0,
            failedAcceptance: 0,
            failedVerifyAcceptance: 0,
            repairScopes: [],
            verifyRepairScopes: [],
            evidenceFiles: [],
            failingEvidence: 0,
            reviewLoopClassRecurrence: [
                { class: 'instrument-unsound', oracle: 'mechanizable', rounds: ['1', '2'], findings: ['A-1', 'B-1'], repairOrigin: 1, stopLineCandidate: true },
            ],
        } as unknown as UpstreamSummary;

        const states: Array<{ field: string; summary: UpstreamSummary; expected: string }> = [
            { field: 'reviewLoop', summary: { ...recurring, reviewLoop: { kind: 'unreadable_current_revision' } } as unknown as UpstreamSummary, expected: 'repair_unreadable_current_revision' },
            { field: 'reviewRecordUnreadable', summary: { ...recurring, reviewRecordUnreadable: 'damaged' } as unknown as UpstreamSummary, expected: 'unreadable_review_record' },
            { field: 'mixedRevisionEvidence', summary: { ...recurring, mixedRevisionEvidence: 'two revisions' } as unknown as UpstreamSummary, expected: 'repair_mixed_revision_evidence' },
            { field: 'ledger', summary: { ...recurring, ledger: { state: 'unreadable', reason: 'damaged' } } as unknown as UpstreamSummary, expected: 'satisfy_ledger_deficits' },
            { field: 'judgeUnreadable', summary: { ...recurring, judgeUnreadable: 'damaged' } as unknown as UpstreamSummary, expected: 'repair_unreadable_record' },
            { field: 'verifyUnreadable', summary: { ...recurring, verifyUnreadable: 'damaged' } as unknown as UpstreamSummary, expected: 'repair_unreadable_record' },
            { field: 'taskUnreadable', summary: { ...recurring, taskUnreadable: 'damaged' } as unknown as UpstreamSummary, expected: 'repair_unreadable_record' },
            { field: 'evidenceUnreadable', summary: { ...recurring, evidenceUnreadable: 'damaged' } as unknown as UpstreamSummary, expected: 'repair_unreadable_record' },
        ];
        for (const state of states) {
            const action = suggestCandidateAction('review', state.summary);
            // The recurrence is present in every row: the report exists and must lose to the state.
            expect(state.summary.reviewLoopClassRecurrence?.some((entry) => entry.stopLineCandidate), state.field).toBe(true);
            expect(action.reason, `${state.field}: ${JSON.stringify(action)}`).toBe(state.expected);
        }
        // And the table is the same one the router reads, with one entry per routed field.
        expect([...new Set(invalidatingStates.map((entry) => entry.field))].sort()).toEqual(states.map((state) => state.field).sort());
    });

    it('publishes the loop replay, so the report is readable and not only testable', async () => {
        // **A report whose only caller is its own selector reaches nobody** (R4-F5): nothing in `src/` imported `loop-replay`,
        // so AC-6 produced a value no operator could read. It is published on the summary `kata-cli status` prints, which is
        // where the decision it exists for is made.
        const built = await summaryWith([
            { at: '1', blockingIds: ['A-1'], blockingCount: 1, findings: [{ id: 'A-1', severity: 'major', class: 'comparison-unnamed', origin: 'original' }] },
            { at: '2', blockingIds: ['B-1'], blockingCount: 1, findings: [{ id: 'B-1', severity: 'major', class: 'comparison-unnamed', origin: 'repair' }] },
        ]);
        const replay = built.summary.reviewLoopReplay;
        expect(replay, 'the summary must carry the replay').toBeTruthy();
        expect(replay?.stopLineCandidates).toEqual(['comparison-unnamed']);
        expect(replay?.repairOriginShare).toBe(0.5);
    });

    it('sends mixed-revision evidence to the seal that must be redone, not to a mechanization', async () => {
        // **The rule is about every precondition, not one instance** (R3-F2). The first repair moved only the
        // `reviewRecordUnreadable` refusal, and an independent round measured the rest: with mixed-revision evidence *and* a
        // recurring class the operator was sent to mechanize the class, when the state that had to be fixed first was the
        // evidence set.
        const both = await summaryWith(
            [
                { at: '1', blockingIds: ['A-1'], blockingCount: 1, findings: [{ id: 'A-1', severity: 'major', class: 'instrument-unsound', origin: 'original' }] },
                { at: '2', blockingIds: ['B-1'], blockingCount: 1, findings: [{ id: 'B-1', severity: 'major', class: 'instrument-unsound', origin: 'repair' }] },
            ],
            { mixedRevisionEvidence: true },
        );
        expect(both.summary.mixedRevisionEvidence, 'the fixture must carry two revisions of evidence').toBeTruthy();
        expect(both.summary.reviewLoopClassRecurrence?.some((entry) => entry.stopLineCandidate)).toBe(true);
        expect(suggestCandidateAction('review', both.summary)).toMatchObject({ reason: 'repair_mixed_revision_evidence' });
    });

    it('sends an unreadable review record to a re-read, not to a mechanization', async () => {
        // **A refusal that names a precondition precedes any report.** The class route was placed above the
        // `unreadable_review_record` refusal (priority 1150), so a recurring class plus a damaged `review.json` sent the
        // operator to `/kata-build` to mechanize a class instead of to `/kata-review` to re-read the record (measured by an
        // independent round). The order now states the rule, and this case carries both facts at once.
        const both = await summaryWith(
            [
                { at: '1', blockingIds: ['A-1'], blockingCount: 1, findings: [{ id: 'A-1', severity: 'major', class: 'instrument-unsound', origin: 'original' }] },
                { at: '2', blockingIds: ['B-1'], blockingCount: 1, findings: [{ id: 'B-1', severity: 'major', class: 'instrument-unsound', origin: 'repair' }] },
            ],
            { corruptReviewRecord: true },
        );
        expect(both.summary.reviewRecordUnreadable, 'the fixture must carry an unreadable record').toBeTruthy();
        expect(both.summary.reviewLoopClassRecurrence?.some((entry) => entry.stopLineCandidate)).toBe(true);
        expect(suggestCandidateAction('review', both.summary)).toMatchObject({ nextSkill: '/kata-review', role: 'reviewer', reason: 'unreadable_review_record' });
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
