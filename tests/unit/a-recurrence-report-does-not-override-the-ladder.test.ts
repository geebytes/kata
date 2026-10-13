import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { initLayout, reviewPath } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { writeCurrentState, type Phase } from '../../src/core/state.js';
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

/**
 * A history that has stopped making progress **on the current revision**, which is what the loop's own switch reads.
 *
 * `roundBoundTo` requires both the revision id and the manifest hash, so a round that names the revision without its hash is
 * history about something else and the switch never sees it — the first version of this fixture wrote `rev-a`/`rev-b` and
 * measured `no_current_rounds`. Three rounds with one unchanged blocking count is the escalation threshold.
 */
function stalledOnCurrentRevision(revisionId: string, manifestHash: string): ReviewRound[] {
    return [1, 2, 3, 4].map((index) => ({
        at: String(index),
        revisionId,
        manifestHash,
        blockingIds: ['A-1'],
        blockingCount: 1,
        findings: [{ id: 'A-1', severity: 'major', class: 'instrument-unsound', origin: index === 1 ? 'original' : 'repair' }],
    }));
}

/**
 * A ledger that has decided something other than `pass`, seeded through the real CLI in the fixture's own root.
 *
 * **The router's precedence is part of what the claims say, so it is asserted rather than described.** The ledger branch sits
 * below the recurrence branches, so a decided-but-failing ledger answers `satisfy_ledger_deficits` even while a stop-line class
 * recurrence is live — an independent review round measured that C2's first clause was false in exactly that state. Seeded with
 * one claim, one witness and no challenge, so `decide` reports `insufficient` for a reason the ledger itself names.
 */
async function seedFailingLedger(root: string): Promise<void> {
    const quiet = async (argv: string[]): Promise<void> => {
        const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
        try {
            await runLedgerCommand(argv, { root, changeId: taskId });
        } finally {
            spy.mockRestore();
        }
    };
    await quiet(['policy', '--init']);
    await quiet(['freeze']);
    await quiet(['claim', 'add', '--statement', 'the subject holds', '--risk-class', 'consistency', '--severity', 'major',
        '--evidence', 'E1', '--depends-on', 'path:subject.ts', '--id', 'C1']);
    const submission = join(root, 'E1.json');
    await writeFile(submission, JSON.stringify({
        claims: [],
        evidence: [{ id: 'E1', type: 'static_witness', ref: 'subject.ts', assertion: 'contains:subject' }],
    }));
    await quiet(['evidence', 'add', '--file', submission]);
    await quiet(['evidence', 'verify']);
}

interface Fixture {
    root: string;
    summary: Awaited<ReturnType<typeof readUpstreamSummary>>;
    revisionId: string;
    manifestHash: string;
}

async function fixtureWith(
    options: { reviewRecord?: 'pending-clean' | 'approved-clean' | 'blocking-finding' | 'major-finding'; rounds?: ReviewRound[]; phase?: Phase; reviewMode?: 'std' | 'strict'; stalledRounds?: boolean } = {},
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
        workflowProfile: { version: 1, isolationMode: 'current_worktree', developmentMode: 'tdd', reviewMode: options.reviewMode ?? 'strict', comet: { projectInit: 'not_requested', openStatus: 'acknowledged' } },
    });
    const sealed = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: ['test'] });
    await writeFile(
        join(root, '.kata', 'evidence', `${taskId}-current.json`),
        `${JSON.stringify({ taskId, kind: 'test', exitCode: 0, revisionId: sealed.revision.id })}\n`,
    );
    await writeFile(reviewRoundsPath(root, taskId), `${(options.stalledRounds ? stalledOnCurrentRevision(sealed.revision.id, sealed.revision.manifestHash) : (options.rounds ?? recyclingRounds)).map((entry) => JSON.stringify(entry)).join('\n')}\n`);

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
    if (options.reviewRecord === 'major-finding') {
        // A `major` finding and nothing at `blocking`: under `strict` the ladder blocks on it too, which is the half of the
        // admission rule a recurrence state never asked about until an independent verifier measured it.
        await writeFile(reviewPath(root, taskId), `${JSON.stringify({ ...binding, status: 'pending', findings: [{ id: 'M-1', taskId, severity: 'major', message: 'a major problem in the current content', falsifies: 'the route admits a repair here' }] })}\n`);
    }
    if (options.phase !== undefined) {
        // The recorded phase is what the entrypoint reads: the router is asked about the state the task is actually in.
        await writeCurrentState(root, {
            taskId,
            phase: options.phase,
            actor: { id: 'kata-reviewer', role: 'reviewer' },
            updatedAt: '2026-10-13T00:00:00.000Z',
        });
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
        //
        // **Both halves of that sentence are asserted.** An independent review round found that this comment claimed the
        // positive pairing while the case only asserted the router's route plus the entry's *refusal* in the empty state —
        // so "the repair it names is one Build admits" was asserted nowhere here, and the pairing is the property this change
        // exists to hold: a route whose destination refuses is the defect, and a route is only fixed when the door opens.
        const admitting = await fixtureWith({ reviewRecord: 'blocking-finding' });
        expect(admitting.summary.blockingFindings).toBeGreaterThan(0);
        expect(suggestCandidateAction('review', admitting.summary)).toMatchObject({ nextSkill: '/kata-build', reason: 'review_class_recurring' });

        const admitted = await authorizeRepair('review', admitting.root, taskId);
        expect(admitted.authorized, admitted.denial).toBe(true);

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
    it('AC-2 (entrypoint): the command the operator actually runs answers with the fresh review', async () => {
        // **The property through the entrypoint, not through the function it calls.** Everything above reads
        // `suggestCandidateAction`, which is what the CLI calls — but the operator runs `kata-cli status`, and a router that
        // answers correctly while the verb that reports it says something else would be the same defect one layer up. The
        // state is the measured one: the recorded phase is `review` and the only live reading is the historical recurrence.
        const { runLocalStatusCommand } = await import('../../src/cli/tasks.js');

        const recurring = await fixtureWith({ phase: 'review' });
        const status = await runLocalStatusCommand(taskId, { taskId, source: 'active' }, recurring.root, { withContext: false });
        expect(status.nextAction).toMatchObject({ nextSkill: '/kata-review', role: 'reviewer', reason: 'complete_review_conclusion' });
        expect((status.nextAction as { cliCommand?: string }).cliCommand).toContain('kata-cli review');

        // The control, through the same verb: where the ladder admits the repair, the CLI still recommends it.
        const admitting = await fixtureWith({ reviewRecord: 'blocking-finding', phase: 'review' });
        const admittingStatus = await runLocalStatusCommand(taskId, { taskId, source: 'active' }, admitting.root, { withContext: false });
        expect(admittingStatus.nextAction).toMatchObject({ nextSkill: '/kata-build', reason: 'review_class_recurring' });
    });

    it('AC-4: the major half of the admission rule is load-bearing, not decoration', async () => {
        // **Measured by an independent verifier, not by me.** It mutated the predicate down to `blockingFindings > 0` — dropping
        // the `strict`-blocks-on-major half — and every selector it tried stayed green, because no case asked the admission
        // question in a state that was *both* recurring and major-only. A predicate whose second half nothing exercises is a
        // predicate that can be deleted without a reading, so the state is asked here.
        const { summary } = await fixtureWith({ reviewRecord: 'major-finding' });
        expect(summary.majorFindings).toBeGreaterThan(0);
        expect(summary.blockingFindings).toBe(0);
        expect(summary.reviewLoopClassRecurrence?.some((entry) => entry.stopLineCandidate)).toBe(true);

        expect(suggestCandidateAction('review', summary)).toMatchObject({ nextSkill: '/kata-build', reason: 'review_class_recurring' });
    });

    it('AC-4: the recurrence routes keep the phase guard the ladder branches carry', async () => {
        // **The same independent verifier's second finding, and a defect this change introduced.** Both branches used to read
        // `phase === 'review' && …`; the rewrite replaced that conjunct with the new predicate, so a recurrence in any *other*
        // phase would have been routed by a rule about reviews. In `judge` the authority is `authorizeJudgeRepair`, which
        // requires a judge FAIL or a superseded revision — a different rule entirely.
        const { summary } = await fixtureWith({ reviewRecord: 'blocking-finding', phase: 'judge' });
        expect(summary.blockingFindings).toBeGreaterThan(0);
        expect(summary.reviewLoopClassRecurrence?.some((entry) => entry.stopLineCandidate)).toBe(true);

        const action = suggestCandidateAction('judge', summary);
        expect(action.reason, JSON.stringify(action)).not.toBe('review_class_recurring');
        expect(action.nextSkill).not.toBe('/kata-build');
    });

    it('AC-4: the id route keeps its phase guard too, and the guard is measured per branch', async () => {
        // The class route's guard and the id route's guard are two sites of one rule, and the first version of this case only
        // drove the class reading — so removing the id route's `phase === 'review'` conjunct stayed green (measured: M7). A
        // guard asserted through its sibling is a guard nothing exercises.
        const recurringIds = [
            { at: '1', revisionId: 'rev-a', blockingIds: ['F-1'], blockingCount: 1 },
            { at: '2', revisionId: 'rev-b', blockingIds: ['F-1'], blockingCount: 1 },
        ];
        const { summary } = await fixtureWith({ rounds: recurringIds, reviewRecord: 'blocking-finding', phase: 'judge' });
        expect(summary.reviewLoopRecurrence, 'the id reading must be live for this case to mean anything').toEqual([{ id: 'F-1', revisions: ['rev-a', 'rev-b'] }]);
        expect(summary.blockingFindings).toBeGreaterThan(0);

        const action = suggestCandidateAction('judge', summary);
        expect(action.reason, JSON.stringify(action)).not.toBe('review_loop_recurring');
        expect(action.nextSkill).not.toBe('/kata-build');
    });

    it('AC-4: the tier half of the admission rule is load-bearing on the negative side too', async () => {
        // **The second independent verifier's finding, and the same class the change is about.** It changed
        // `blockingSeverities.length > 1` to `> 0` — making every tier claim to block on major findings — and the entire
        // suite stayed green while the behaviour moved: at `std` the ladder blocks on `blocking` alone, `authorizeRepair`
        // refuses a major-only state, and the mutated predicate would send that state to the Build it cannot enter. That is
        // exactly the unreachable destination this change removes, reappearing one tier down with nothing to catch it.
        const { summary } = await fixtureWith({ reviewRecord: 'major-finding', reviewMode: 'std' });
        expect(summary.majorFindings).toBeGreaterThan(0);
        expect(summary.blockingFindings).toBe(0);
        expect(summary.reviewMode).toBe('std');
        expect(summary.reviewLoopClassRecurrence?.some((entry) => entry.stopLineCandidate)).toBe(true);

        const action = suggestCandidateAction('review', summary);
        expect(action.reason, JSON.stringify(action)).not.toBe('review_class_recurring');
        expect(action.nextSkill).not.toBe('/kata-build');
    });

    it('AC-4: the class route outranks the id route when both readings are live', async () => {
        // The code comment claims this order ("it sits above the id-based route because a class recurring inside a repair
        // says more than one id repeating") and the verifier measured that swapping the two branches stayed green — the
        // claim was in a comment and nowhere else. One round history can carry both readings: the same id across revisions
        // *and* the same class with a repair origin.
        const bothReadings = [
            { at: '1', revisionId: 'rev-a', blockingIds: ['F-1'], blockingCount: 1, findings: [{ id: 'F-1', severity: 'major', class: 'instrument-unsound', origin: 'original' }] },
            { at: '2', revisionId: 'rev-b', blockingIds: ['F-1'], blockingCount: 1, findings: [{ id: 'F-1', severity: 'major', class: 'instrument-unsound', origin: 'repair' }] },
        ];
        const { summary } = await fixtureWith({ rounds: bothReadings, reviewRecord: 'blocking-finding' });
        expect(summary.reviewLoopClassRecurrence?.some((entry) => entry.stopLineCandidate), 'the class reading must be live').toBe(true);
        expect(summary.reviewLoopRecurrence?.length, 'the id reading must be live too').toBeGreaterThan(0);

        expect(suggestCandidateAction('review', summary)).toMatchObject({ nextSkill: '/kata-build', reason: 'review_class_recurring' });

        // **The published ordering, at equal counts — and its boundary, stated rather than assumed.** The two routes carry a
        // priority whose *base* differs (`2150 + candidates.length` against `2100 + ids`), which `listTaskCandidates` sorts
        // descending by. A third verifier measured that dropping the class route's priority below the id route's base stayed
        // green: the ordering the numbers exist for was asserted nowhere. An independent review round then measured that the
        // sentence this comment used to carry ("so the sharper reading is the one an operator sees first") was false in a
        // regime this case cannot see: the class count is bounded by the number of stop-line classes while the id count is
        // unbounded, so a change carrying 51 or more recurring ids publishes the higher number and sorts first. The claim and
        // this comment now state the measured regime (equal counts) and its boundary; the absolute value is still not pinned,
        // because it is a published hint and pinning it would fail on an unrelated task count.
        const classAction = suggestCandidateAction('review', summary);
        const idOnly = await fixtureWith({
            rounds: [
                { at: '1', revisionId: 'rev-a', blockingIds: ['F-1'], blockingCount: 1, findings: [{ id: 'F-1', severity: 'major', class: 'instrument-unsound', origin: 'original' }] },
                { at: '2', revisionId: 'rev-b', blockingIds: ['F-1'], blockingCount: 1, findings: [{ id: 'F-1', severity: 'major', class: 'contract-semantics', origin: 'original' }] },
            ],
            reviewRecord: 'blocking-finding',
        });
        const idAction = suggestCandidateAction('review', idOnly.summary);
        expect(idAction.reason, JSON.stringify(idAction)).toBe('review_loop_recurring');
        expect(classAction.priority, `${classAction.priority} vs ${idAction.priority}`).toBeGreaterThan(idAction.priority!);
    });

    it('AC-4: the priority boundary the claim names is measured, not just stated', async () => {
        // **A review round found the boundary sentence off by one and then found it unasserted — so it is measured here.** The
        // class route publishes `2150 + candidates.length` and the id route `2100 + ids`, so the crossover is `ids > 50 +
        // candidates`: with one stop-line candidate, 52 recurring ids publish the strictly higher number, and at exactly 51 the
        // two publish the same `2151`, where `listTaskCandidates`' tiebreak decides rather than the recurrence. A claim that
        // names a boundary nobody measures is the shape this change exists to remove, so the three regimes are asserted: below
        // it the class route wins, at it the numbers are equal, above it the id route wins.
        const classRoute = async (): Promise<number> => {
            const { summary } = await fixtureWith({
                rounds: [
                    { at: '1', revisionId: 'rev-a', blockingIds: ['F-1'], blockingCount: 1, findings: [{ id: 'F-1', severity: 'major', class: 'instrument-unsound', origin: 'original' }] },
                    { at: '2', revisionId: 'rev-b', blockingIds: ['F-1'], blockingCount: 1, findings: [{ id: 'F-1', severity: 'major', class: 'instrument-unsound', origin: 'repair' }] },
                ],
                reviewRecord: 'blocking-finding',
            });
            return suggestCandidateAction('review', summary).priority!;
        };
        const idRouteWith = async (ids: number): Promise<number> => {
            // An id counts as recurring only when it appears in **two or more revisions**, so both rounds carry the same ids;
            // one round each would leave every id with a single revision and the id route would never fire (measured: 1001,
            // the ladder's own repair route, because the reading was empty).
            const recurring = Array.from({ length: ids }, (_, index) => `F-${index + 1}`);
            const findings = recurring.map((id) => ({ id, severity: 'major', class: 'contract-semantics', origin: 'original' }));
            const rounds = [
                { at: '1', revisionId: 'rev-a', blockingIds: recurring, blockingCount: ids, findings },
                { at: '2', revisionId: 'rev-b', blockingIds: recurring, blockingCount: ids, findings },
            ];
            const { summary } = await fixtureWith({ rounds, reviewRecord: 'blocking-finding' });
            expect(summary.reviewLoopClassRecurrence?.some((entry) => entry.stopLineCandidate), 'the class reading must not be a stop-line candidate here').toBe(false);
            expect(summary.reviewLoopRecurrence?.length, `the id reading must count ${ids} ids`).toBe(ids);
            return suggestCandidateAction('review', summary).priority!;
        };

        const oneClass = await classRoute();
        expect(oneClass, 'one stop-line class publishes 2151').toBe(2151);
        expect(await idRouteWith(50), '50 ids: below the boundary, the class route still wins').toBeLessThan(oneClass);
        expect(await idRouteWith(51), '51 ids: the two numbers are equal, and the tiebreak is the taskId').toBe(oneClass);
        expect(await idRouteWith(52), '52 ids: the id route publishes strictly more').toBeGreaterThan(oneClass);
    });

    it('AC-4: a live class reading that is not a stop-line candidate leaves the id route to speak', async () => {
        // **An independent review round's finding: C8's first clause needed a qualifier it omitted.** The class route fires only
        // for a *stop-line* class, so a class reading that is present but not a candidate — a judgment class, or a mechanizable
        // one that never recurred inside a repair — does not answer for the change; if an id reading is live too, that route
        // answers instead. Without this case the qualifier was carried by prose alone, and the change's own origin-half case
        // already demonstrates the shape (its live class reading carries `stopLineCandidate === false`).
        const notACandidate = [
            { at: '1', revisionId: 'rev-a', blockingIds: ['F-1'], blockingCount: 1, findings: [{ id: 'F-1', severity: 'major', class: 'instrument-unsound', origin: 'original' }] },
            { at: '2', revisionId: 'rev-b', blockingIds: ['F-1'], blockingCount: 1, findings: [{ id: 'F-1', severity: 'major', class: 'instrument-unsound', origin: 'original' }] },
        ];
        const { summary } = await fixtureWith({ rounds: notACandidate, reviewRecord: 'blocking-finding' });
        const reading = (summary.reviewLoopClassRecurrence ?? []).find((entry) => entry.class === 'instrument-unsound');
        expect(reading, 'the class reading must be live').toBeDefined();
        expect(reading!.stopLineCandidate, 'and it must not be a stop-line candidate, or this case tests nothing').toBe(false);
        expect(summary.reviewLoopRecurrence?.length, 'the id reading must be live as well').toBeGreaterThan(0);

        expect(suggestCandidateAction('review', summary)).toMatchObject({ nextSkill: '/kata-build', reason: 'review_loop_recurring' });
    });

    it('AC-4: a class recurrence the design calls normal is not routed to a repair', async () => {
        // `classRecurrence`'s own doc says the stop-line filter is deliberate in both halves: **`mechanizable` only**, because
        // "a `judgment` class recurring is normal — two independent rounds can each find a distinct intent omission, which is
        // the instrument working. Escalating on that would be a false stop." A third verifier measured that deleting that half
        // stayed green (selector and full suite) while the reason moved: an admitting ladder plus a judgment-class recurrence
        // reported `repair_blocking_review_findings` and would report `review_class_recurring` without the filter.
        //
        // The route is a plain repair route, not a gate: `review_class_recurring` is `null` in `trustBoundaryByReason` and
        // needs no confirmation. `escalate_review_without_progress` is the stop-line escalation and a different branch — an
        // independent review round corrected this case's own wording, which had called the route an escalation.
        const judgmentRounds = [
            { at: '1', revisionId: 'rev-a', blockingIds: ['F-1'], blockingCount: 1, findings: [{ id: 'F-1', severity: 'major', class: 'an-unrecognised-class', origin: 'original' }] },
            { at: '2', revisionId: 'rev-b', blockingIds: ['F-2'], blockingCount: 1, findings: [{ id: 'F-2', severity: 'major', class: 'an-unrecognised-class', origin: 'repair' }] },
        ];
        const { summary } = await fixtureWith({ rounds: judgmentRounds, reviewRecord: 'blocking-finding' });
        const reading = summary.reviewLoopClassRecurrence ?? [];
        expect(reading.length, 'the class reading must be live for this case to mean anything').toBeGreaterThan(0);
        expect(reading.every((entry) => !entry.stopLineCandidate), 'a judgment class is not a stop-line candidate').toBe(true);

        const action = suggestCandidateAction('review', summary);
        expect(action.reason, JSON.stringify(action)).not.toBe('review_class_recurring');
        expect(action.reason, JSON.stringify(action)).toBe('repair_blocking_review_findings');
    });

    it('AC-4: the origin half of the stop-line filter is driven through the route as well', async () => {
        // **An independent review round's finding, and the same defect this change is about, one half over.** The case above
        // exercises the `oracle === 'mechanizable'` half: its class is unrecognised, so the oracle alone decides. The *origin*
        // half (`repairOrigin > 0`) was therefore unmeasured through the route — a route that re-derived the filter as
        // `(entry) => entry.oracle === 'mechanizable'`, keeping one half and dropping the other, stayed green across the whole
        // suite. The only fixture with this shape lived in another selector and carried no review record, so its assertion
        // passed because the ladder admitted nothing, not because the filter filtered.
        const originalOnly = [
            { at: '1', revisionId: 'rev-a', blockingIds: ['F-1'], blockingCount: 1, findings: [{ id: 'F-1', severity: 'major', class: 'instrument-unsound', origin: 'original' }] },
            { at: '2', revisionId: 'rev-b', blockingIds: ['F-2'], blockingCount: 1, findings: [{ id: 'F-2', severity: 'major', class: 'instrument-unsound', origin: 'original' }] },
        ];
        const { summary } = await fixtureWith({ rounds: originalOnly, reviewRecord: 'blocking-finding' });
        const reading = (summary.reviewLoopClassRecurrence ?? []).find((entry) => entry.class === 'instrument-unsound');
        expect(reading, 'the class reading must be live').toBeDefined();
        expect(reading!.oracle, 'the oracle half must be satisfied, or this case would pass for the wrong reason').toBe('mechanizable');
        expect(reading!.repairOrigin, 'and the origin half must be the one that decides').toBe(0);
        expect(reading!.stopLineCandidate).toBe(false);
        expect(summary.blockingFindings, 'the ladder must admit a repair, or the route is silent for another reason').toBeGreaterThan(0);

        const action = suggestCandidateAction('review', summary);
        expect(action.reason, JSON.stringify(action)).not.toBe('review_class_recurring');
        expect(action.reason, JSON.stringify(action)).toBe('repair_blocking_review_findings');
    });

    it('AC-4: the phase guard is asserted for every phase it excludes, not just judge', async () => {
        // The first version of the phase case drove `judge` alone, so `phase === 'review'` → `phase !== 'judge'` stayed
        // green while `hardVerify` — a phase this change's own comment names — would have been routed by a review rule.
        for (const phase of ['judge', 'hardVerify'] as const) {
            const { summary } = await fixtureWith({ reviewRecord: 'blocking-finding', phase });
            expect(summary.blockingFindings, phase).toBeGreaterThan(0);
            expect(summary.reviewLoopClassRecurrence?.some((entry) => entry.stopLineCandidate), phase).toBe(true);

            const action = suggestCandidateAction(phase, summary);
            expect(action.reason, `${phase}: ${JSON.stringify(action)}`).not.toBe('review_class_recurring');
            expect(action.nextSkill, phase).not.toBe('/kata-build');
        }
    });

    it('AC-4: the precedence the claims name is asserted, not described', async () => {
        // **An independent review round's finding, three times over, and the class-level remedy.** Rounds 2 and 3 each found a
        // claim that stated a route without the precedence the router actually applies — the recurrence branches sit *below* the
        // review loop's own switch and the ledger branch, and above nothing that outranks them. The clauses were true only in
        // the state that also admitted a repair. So the three exception states are asserted here rather than listed in prose:
        // a clause that names a precedence is worth exactly what the state asserting it is worth.
        //
        // (1) Both readings live and nothing at the bar — AC-1's own state, where the routes are silent and the fresh review
        //     answers. This is the state in which the claim's first clause used to be false.
        const bothReadings = [
            { at: '1', revisionId: 'rev-a', blockingIds: ['F-1'], blockingCount: 1, findings: [{ id: 'F-1', severity: 'major', class: 'instrument-unsound', origin: 'original' }] },
            { at: '2', revisionId: 'rev-b', blockingIds: ['F-1'], blockingCount: 1, findings: [{ id: 'F-1', severity: 'major', class: 'instrument-unsound', origin: 'repair' }] },
        ];
        const silent = await fixtureWith({ rounds: bothReadings });
        expect(silent.summary.reviewLoopClassRecurrence?.some((entry) => entry.stopLineCandidate), 'the class reading must be live').toBe(true);
        expect(silent.summary.reviewLoopRecurrence?.length, 'and the id reading too').toBeGreaterThan(0);
        expect(silent.summary.blockingFindings, 'and the ladder must admit nothing').toBe(0);
        expect(suggestCandidateAction('review', silent.summary)).toMatchObject({ nextSkill: '/kata-review', reason: 'complete_review_conclusion' });

        // (2) A loop that has stopped making progress: the switch answers first, and it is a human decision rather than a repair.
        const stalled = await fixtureWith({ reviewRecord: 'blocking-finding', stalledRounds: true });
        expect(stalled.summary.reviewLoop?.kind, 'the switch must own this state').toBe('stalled_current_rounds');
        expect(stalled.summary.reviewLoopClassRecurrence?.some((entry) => entry.stopLineCandidate), 'with the class reading still live').toBe(true);
        expect(suggestCandidateAction('review', stalled.summary)).toMatchObject({ nextSkill: '/kata-review', reason: 'escalate_review_without_progress' });

        // (3) A ledger that decided anything but `pass`: the ledger branch answers, and its destination does open.
        const failing = await fixtureWith();
        await seedFailingLedger(failing.root);
        const withLedger = await readUpstreamSummary(failing.root, taskId);
        expect(withLedger.ledger?.state, 'the ledger must have decided').toBe('decided');
        expect(withLedger.ledger?.verdict, 'and not have passed').not.toBe('pass');
        expect(withLedger.reviewLoopClassRecurrence?.some((entry) => entry.stopLineCandidate), 'with the class reading still live').toBe(true);
        const ledgerAction = suggestCandidateAction('review', withLedger);
        expect(ledgerAction.reason, JSON.stringify(ledgerAction)).toBe('satisfy_ledger_deficits');
        expect(ledgerAction.nextSkill).toBe('/kata-build');
    });
});
