import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout, reviewPath } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import {
    classOccurrences,
    classesWhoseExitIsDue,
    clearedClasses,
    declarationsOfRecord,
    openClosureObligations,
    readRepairDeclarations,
    type ClassOccurrence,
    type RepairDeclaration,
} from '../../src/quality/repair-declarations.js';
import { buildChangeRecord, writeChangeRecord } from '../../src/quality/change-record.js';
import { reviewRoundsPath, type ReviewRound } from '../../src/quality/repair.js';
import { nextActionForTask, readUpstreamSummary, suggestCandidateAction } from '../../src/workflow/navigation.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';

/**
 * **The exit a repair contract declares, turned into a decision — and the ordering that makes it one.**
 *
 * The recurrence packet can name the class and demand a closure obligation; nothing read whether that obligation was ever
 * honoured. Measured on `the-gates-can-be-repaired`: eight rounds, three classes at the stop line, every round concluding
 * `instrument_unsound`/`workflow_routing_error`/`behaviour_defect` and asking for a repair, and every repair coming back to
 * the same class one site over.
 *
 * The first version of this module made the exit due on the bare conjunction "the class is a stop-line candidate AND its
 * latest conclusion asked for a repair" — which is exactly the state a root-cause round leaves behind, so **the declaration
 * was itself the recurrence it pointed at** and the repair it had just contracted could never be attempted. A conclusion is a
 * statement about the past; what makes its exit due is the class coming back *after* it, on a revision sealed in between.
 * These cases pin both directions, because only holding both makes the mechanism an exit rather than a trap.
 */
const taskId = 'a-declared-repair';

const obligation = {
    states: ['the class is decided per site', 'the class is decided by one derivation'],
    sourceOfTruth: 'theOneDerivation',
    inventory: ['src/a.ts:10'],
    invariant: 'every site asks the one derivation',
    repairSurface: ['src/a.ts'],
    effectivenessTest: 'tests/unit/a.test.ts',
    ifRecursAgain: 'rewrite_mechanism' as const,
};

const declaration = (defectClass: string, conclusion: string, extra: Partial<RepairDeclaration> = {}): RepairDeclaration => ({
    defectClass,
    conclusion,
    ...extra,
});

const occurrence = (defectClass: string, roundAt: string, origin: 'original' | 'repair', revisionId?: string): ClassOccurrence => ({
    defectClass,
    roundAt,
    origin,
    ...(revisionId === undefined ? {} : { revisionId }),
});

describe('a declared repair that did not hold is a terminal exit, not another repair', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    it('is due only when the class recurred after the declaration, on a later revision of the chain', () => {
        // The declaring round ran on `revision-a` and recorded its conclusion at T1. The class came back in a round on
        // `revision-b` at T2 — a repair was sealed in between and did not hold. Both facts, in that order.
        const chain = ['revision-a', 'revision-b'];
        const declared = declaration('instrument-unsound', 'instrument_unsound', { at: '2026-01-01T00:00:00.000Z', revisionId: 'revision-a' });

        expect(classesWhoseExitIsDue([declared], [occurrence('instrument-unsound', '2026-02-01T00:00:00.000Z', 'repair', 'revision-b')], chain).due)
            .toEqual([{
                defectClass: 'instrument-unsound',
                declaredAt: '2026-01-01T00:00:00.000Z',
                declaredRevisionId: 'revision-a',
                conclusion: 'instrument_unsound',
                recurredAt: '2026-02-01T00:00:00.000Z',
                recurredRevisionId: 'revision-b',
            }]);

        // **The case the first version got wrong.** The recurrences are the ones the declaration was *written about* — they
        // precede it. Nothing has happened since, so the repair the round contracted is still owed and the exit is not due.
        expect(classesWhoseExitIsDue(
            [declared],
            [occurrence('instrument-unsound', '2025-12-01T00:00:00.000Z', 'repair', 'revision-a')],
            chain,
        ).due).toEqual([]);

        // A recurrence on the declaration's own revision is the same review looking again, not a repair that failed: no
        // revision was sealed in between.
        expect(classesWhoseExitIsDue(
            [declared],
            [occurrence('instrument-unsound', '2026-02-01T00:00:00.000Z', 'repair', 'revision-a')],
            chain,
        ).due).toEqual([]);

        // Recurs after the declaration, but only as an *original* defect: a class the repair did not address is not a
        // repair that failed, and spending the exit on it would end the change for someone else's finding.
        expect(classesWhoseExitIsDue(
            [declared],
            [occurrence('instrument-unsound', '2026-02-01T00:00:00.000Z', 'original', 'revision-b')],
            chain,
        ).due).toEqual([]);

        // A different class than the declared one is a different question.
        expect(classesWhoseExitIsDue([declared], [occurrence('refusal-cannot-be-executed', '2026-02-01T00:00:00.000Z', 'repair', 'revision-b')], chain).due)
            .toEqual([]);
    });

    it('names an undecidable order instead of reporting that the repair held', () => {
        // A declaration with no recorded time cannot be ordered against anything. Reporting "not due" would let the loop run
        // on a record the mechanism cannot read, which is the direction that never ends.
        const undated = classesWhoseExitIsDue(
            [declaration('instrument-unsound', 'instrument_unsound', { revisionId: 'revision-a' })],
            [occurrence('instrument-unsound', '2026-02-01T00:00:00.000Z', 'repair', 'revision-b')],
            ['revision-a', 'revision-b'],
        );
        expect(undated.due).toEqual([]);
        expect(undated.undecidable).toEqual(['instrument-unsound']);

        // And a class whose recurrence is entirely before its declaration is decided, not undecidable: "the repair is still
        // owed" is a reading the record supports.
        const decided = classesWhoseExitIsDue(
            [declaration('instrument-unsound', 'instrument_unsound', { at: '2026-03-01T00:00:00.000Z', revisionId: 'revision-a' })],
            [occurrence('instrument-unsound', '2026-02-01T00:00:00.000Z', 'repair', 'revision-a')],
            ['revision-a', 'revision-b'],
        );
        expect(decided).toEqual({ due: [], undecidable: [] });
    });

    it('lets a later round clear the class instead of spending it', () => {
        // `not_same_class` says the findings are no longer one class, which answers the class question. The class then stops
        // raising the packet — otherwise every round after it is dispatched as a root-cause round for a question a previous
        // round already answered, which is how `resume_certification` became unreachable in the first version.
        const declarations = [
            declaration('instrument-unsound', 'instrument_unsound', { at: '2026-01-01T00:00:00.000Z', revisionId: 'revision-a' }),
            declaration('instrument-unsound', 'not_same_class', { at: '2026-02-01T00:00:00.000Z', revisionId: 'revision-b' }),
        ];
        const occurrences = [occurrence('instrument-unsound', '2026-01-15T00:00:00.000Z', 'repair', 'revision-a')];

        expect(classesWhoseExitIsDue(declarations, occurrences, ['revision-a', 'revision-b']).due).toEqual([]);
        expect(clearedClasses(declarations, occurrences)).toEqual(['instrument-unsound']);

        // A recurrence **after** the clearing re-arms both: the class is one class again, and the older repair conclusion is
        // history once more.
        const recurring = [...occurrences, occurrence('instrument-unsound', '2026-03-01T00:00:00.000Z', 'repair', 'revision-c')];
        expect(clearedClasses(declarations, recurring)).toEqual([]);
        expect(classesWhoseExitIsDue(declarations, recurring, ['revision-a', 'revision-b', 'revision-c']).due).toEqual([]);

        // And a repair conclusion recorded after a cleared round re-arms the exit on the same terms as any other declaration:
        // declaration first, recurrence after, on a later revision.
        const rearmed = [
            declarations[0]!,
            declaration('instrument-unsound', 'behaviour_defect', { at: '2026-02-15T00:00:00.000Z', revisionId: 'revision-b' }),
        ];
        expect(classesWhoseExitIsDue(rearmed, recurring, ['revision-a', 'revision-b', 'revision-c']).due)
            .toEqual([{
                defectClass: 'instrument-unsound',
                declaredAt: '2026-02-15T00:00:00.000Z',
                declaredRevisionId: 'revision-b',
                conclusion: 'behaviour_defect',
                recurredAt: '2026-03-01T00:00:00.000Z',
                recurredRevisionId: 'revision-c',
            }]);
    });

    it('does not treat a conclusion that asks for something other than a repair as a spent repair', () => {
        // `claim_scope_error` routes to `restate_claim`; it never promised a repair, so nothing was spent.
        expect(classesWhoseExitIsDue(
            [declaration('instrument-unsound', 'claim_scope_error', { at: '2026-01-01T00:00:00.000Z', revisionId: 'revision-a' })],
            [occurrence('instrument-unsound', '2026-02-01T00:00:00.000Z', 'repair', 'revision-b')],
            ['revision-a', 'revision-b'],
        ).due).toEqual([]);
    });

    it('reports the obligations still open, which are the ones a seal has to satisfy', () => {
        // What makes an obligation open is the same ordering as what makes an exit due: the conclusion asked for a repair and
        // the class has not come back since. This is the set the seal is contracted to.
        const open = declaration('instrument-unsound', 'instrument_unsound', {
            at: '2026-01-01T00:00:00.000Z',
            revisionId: 'revision-a',
            closureObligation: obligation,
            ifRecursAgain: 'rewrite_mechanism',
        });
        const spent = declaration('refusal-cannot-be-executed', 'behaviour_defect', {
            at: '2026-01-01T00:00:00.000Z',
            revisionId: 'revision-a',
            closureObligation: obligation,
        });
        const occurrences = [
            occurrence('instrument-unsound', '2025-12-01T00:00:00.000Z', 'repair', 'revision-a'),
            occurrence('refusal-cannot-be-executed', '2026-02-01T00:00:00.000Z', 'repair', 'revision-b'),
        ];

        expect(openClosureObligations([open, spent], occurrences).map((entry) => entry.defectClass))
            .toEqual(['instrument-unsound']);
        // A class with no obligation is not in the set: the packet only demands one for a repair conclusion, and a legacy
        // record has none to satisfy.
        expect(openClosureObligations([declaration('instrument-unsound', 'instrument_unsound', { at: '2026-01-01T00:00:00.000Z', revisionId: 'revision-a' })], []))
            .toEqual([]);
    });

    it('reads declarations out of the record shape the change itself writes', () => {
        const read = declarationsOfRecord({
            recordedAt: '2026-01-01T00:00:00.000Z',
            archivedAt: '2026-02-01T00:00:00.000Z',
            reviewedRevisionId: 'revision-a',
            recurrenceAnalysis: {
                triggerClasses: ['instrument-unsound', 'one-fact-derived-twice'],
                conclusion: 'instrument_unsound',
                evidence: ['review-rounds.jsonl:1-3'],
                nextAction: 'repair',
                closureObligation: obligation,
            },
        });
        expect(read.ok).toBe(true);
        if (!read.ok) throw new Error('unreachable');
        // **`recordedAt`, not `archivedAt`.** The archive time is when the record was replaced, which is *after* the rounds
        // that replaced it — using it would make a declaration look later than recurrences that actually followed it, and the
        // exit would never be due. The archived copy keeps the original stamp, so the ordering survives archiving.
        expect(read.declarations).toEqual([
            { defectClass: 'instrument-unsound', at: '2026-01-01T00:00:00.000Z', revisionId: 'revision-a', conclusion: 'instrument_unsound', ifRecursAgain: 'rewrite_mechanism', closureObligation: obligation },
            { defectClass: 'one-fact-derived-twice', at: '2026-01-01T00:00:00.000Z', revisionId: 'revision-a', conclusion: 'instrument_unsound', ifRecursAgain: 'rewrite_mechanism', closureObligation: obligation },
        ]);
        // The legacy shape: an archived row from before the writer stamped a time falls back to `archivedAt` rather than
        // losing its ordering entirely.
        const legacy = declarationsOfRecord({
            archivedAt: '2026-02-01T00:00:00.000Z',
            revisionId: 'revision-a',
            recurrenceAnalysis: { triggerClasses: ['instrument-unsound'], conclusion: 'instrument_unsound', evidence: ['x'], nextAction: 'repair', closureObligation: obligation },
        });
        expect(legacy.ok && legacy.declarations[0].at).toBe('2026-02-01T00:00:00.000Z');
        // A round that ran without the packet declared nothing; a record with no analysis is not an error.
        expect(declarationsOfRecord({ findings: [] })).toEqual({ ok: true, declarations: [] });
        expect(declarationsOfRecord(null)).toEqual({ ok: true, declarations: [] });
        // **A damaged declaration is named, not dropped.** The reader's first version returned `[]` for anything it could not
        // make sense of, so a malformed conclusion read as "nothing was ever declared" — the reading that routes back to
        // another repair, which is the one direction where being wrong restarts the loop.
        for (const broken of [
            { recurrenceAnalysis: { triggerClasses: ['x'], conclusion: 'real_behaviour_defect', evidence: ['e'], nextAction: 'repair' } },
            { recurrenceAnalysis: { triggerClasses: [], conclusion: 'instrument_unsound', evidence: ['e'], nextAction: 'repair' } },
            { recurrenceAnalysis: 'not an object' },
        ]) {
            expect(declarationsOfRecord(broken).ok).toBe(false);
        }
        // An obligation whose exit is outside the vocabulary is refused for the same reason: it is a declaration no route can
        // act on.
        expect(declarationsOfRecord({
            recurrenceAnalysis: {
                triggerClasses: ['x'], conclusion: 'instrument_unsound', evidence: ['e'], nextAction: 'repair',
                closureObligation: { ...obligation, ifRecursAgain: 'repair' },
            },
        }).ok).toBe(false);
    });

    it('names an unreadable history rather than reporting that nothing was ever declared', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-declared-repair-'));
        roots.push(root);
        await initLayout(root);
        await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
        // A line that cannot be parsed would otherwise truncate the declaration list silently — and "nothing was declared"
        // is the state that routes back to another repair.
        await writeFile(join(root, '.kata', 'tasks', taskId, 'review-history.jsonl'), `${JSON.stringify({ archivedAt: 'x' })}\n{\n`);

        const read = await readRepairDeclarations(root, taskId);

        expect(read.kind).toBe('unreadable');
        expect(read.detail).toContain('line 2');
    });

    it('scopes declarations to the chain in hand and counts what it cannot attribute', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-declared-repair-scope-'));
        roots.push(root);
        await initLayout(root);
        await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
        const row = (revisionId: string | undefined, at: string): string => `${JSON.stringify({
            recordedAt: at,
            ...(revisionId === undefined ? {} : { revisionId }),
            recurrenceAnalysis: { triggerClasses: ['instrument-unsound'], conclusion: 'instrument_unsound', evidence: ['e'], nextAction: 'repair', closureObligation: obligation },
        })}\n`;
        await writeFile(join(root, '.kata', 'tasks', taskId, 'review-history.jsonl'), [
            row('revision-other', '2026-01-01T00:00:00.000Z'),
            row(undefined, '2026-01-02T00:00:00.000Z'),
        ].join(''));
        await writeFile(join(root, '.kata', 'tasks', taskId, 'review.json'), JSON.stringify({
            recordedAt: '2026-01-03T00:00:00.000Z',
            revisionId: 'revision-a',
            recurrenceAnalysis: { triggerClasses: ['instrument-unsound'], conclusion: 'instrument_unsound', evidence: ['e'], nextAction: 'repair', closureObligation: obligation },
        }));

        const read = await readRepairDeclarations(root, taskId, ['revision-a', 'revision-b']);

        // A conclusion on another lineage must not decide this chain's exit, and a conclusion that names no revision cannot
        // be attributed at all — counted, so an operator sees that history exists which this mechanism cannot read.
        expect(read.declarations.map((entry) => entry.revisionId)).toEqual(['revision-a']);
        expect(read.unattributable).toBe(2);
    });

    it('routes a spent repair to the terminal decision, where the class route would buy the same repair again', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-declared-repair-route-'));
        roots.push(root);
        await initLayout(root);
        // `createTask` refuses an id whose directory exists, so the fixture does not pre-create it.
        await createTask({
            root,
            id: taskId,
            title: 'A declared repair that did not hold',
            acceptance: [{ id: 'AC-1', statement: 'The route follows the record.' }],
            ownedPaths: ['subject.ts'],
            workflowProfile: { version: 1, isolationMode: 'current_worktree', developmentMode: 'tdd', reviewMode: 'strict', comet: { projectInit: 'not_requested', openStatus: 'acknowledged' } },
        });
        await writeFile(join(root, 'subject.ts'), 'export const subject = true;\n');
        const first = await sealFixture(root, 'export const subject = 0;\n', undefined);
        // The round that produced the recurrence, and the root-cause conclusion recorded about it: both on `first`.
        await writeFile(reviewRoundsPath(root, taskId), `${JSON.stringify({
            at: '2026-01-01T00:00:00.000Z',
            revisionId: first.id,
            manifestHash: first.manifestHash,
            blockingIds: ['F-1'],
            blockingCount: 1,
            kind: 'root_cause',
            findings: [{ id: 'F-1', severity: 'major', class: 'instrument-unsound', origin: 'original' }],
        })}\n`);
        await writeFile(reviewPath(root, taskId), `${JSON.stringify({
            revisionId: first.id,
            manifestHash: first.manifestHash,
            reviewedRevisionId: first.id,
            recordedAt: '2026-01-02T00:00:00.000Z',
            reviewKind: 'root_cause',
            recurrenceAnalysis: {
                triggerClasses: ['instrument-unsound'],
                conclusion: 'instrument_unsound',
                evidence: ['review-rounds.jsonl:1'],
                nextAction: 'repair',
                closureObligation: obligation,
            },
            findings: [{ id: 'F-1', taskId, severity: 'major', message: 'the class recurring inside its own repair', class: 'instrument-unsound' }],
            status: 'pending',
        })}\n`);

        // **The state the first version called terminal.** The declaration has just been written and no repair has been
        // sealed since, so the exit is not due and the round goes back to Build with its contract in hand.
        const beforeRepair = await readUpstreamSummary(root, taskId);
        expect(beforeRepair.reviewExitDue).toBeUndefined();
        // The ladder's own repair route (a `major` finding at `strict`), not the terminal escalation: the class-level repair the
        // round just contracted has to be allowed to happen before its exit can be due.
        expect(suggestCandidateAction('review', beforeRepair).nextSkill).toBe('/kata-build');
        expect(suggestCandidateAction('review', beforeRepair).reason).not.toBe('escalate_declared_repair_did_not_hold');

        // The repair: a new revision sealed on top of `first`, whose review found the same class again from the repair.
        const second = await sealFixture(root, 'export const subject = 1;\n', first.id);
        await writeFile(reviewRoundsPath(root, taskId), [
            JSON.stringify({
                at: '2026-01-01T00:00:00.000Z', revisionId: first.id, manifestHash: first.manifestHash,
                blockingIds: ['F-1'], blockingCount: 1, kind: 'root_cause',
                findings: [{ id: 'F-1', severity: 'major', class: 'instrument-unsound', origin: 'original' }],
            }),
            JSON.stringify({
                at: '2026-01-03T00:00:00.000Z', revisionId: second.id, manifestHash: second.manifestHash,
                blockingIds: ['F-2'], blockingCount: 1, kind: 'focused_followup',
                findings: [{ id: 'F-2', severity: 'major', class: 'instrument-unsound', origin: 'repair' }],
            }),
        ].join('\n') + '\n');

        const summary = await readUpstreamSummary(root, taskId);

        expect(summary.reviewExitDue?.map((entry) => entry.defectClass)).toEqual(['instrument-unsound']);
        expect(summary.reviewExitDue?.[0]).toMatchObject({
            declaredAt: '2026-01-02T00:00:00.000Z',
            declaredRevisionId: first.id,
            recurredRevisionId: second.id,
            declaredExit: 'rewrite_mechanism',
        });
        const action = suggestCandidateAction('review', summary);
        // Terminal, where the class-recurring route below would answer `/kata-build` — the same repair, bought again.
        expect(action).toMatchObject({ reason: 'escalate_declared_repair_did_not_hold', nextSkill: '/kata', role: 'dispatcher' });
        expect(action.reason).not.toBe('review_class_recurring');
        // **And the stop is a stop for the machine as well as the reader.** The reason was added to the escalation branch but
        // not to the confirmation flag, so the one route whose whole purpose is "a person picks one of three terminal exits"
        // was legal for a host to continue on its own.
        const nextAction = nextActionForTask(taskId, action.nextSkill, action.role, action.reason);
        expect(nextAction.requiresUserConfirmation).toBe(true);
        expect(nextAction.escalationExits).toEqual(['rewrite_mechanism', 'waive_with_owner', 'abandon_change']);
    });

    it('still routes an undeclared recurring class back to repair with a contract', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-declared-repair-open-'));
        roots.push(root);
        await initLayout(root);
        await createTask({
            root,
            id: taskId,
            title: 'A class that has not been declared yet',
            acceptance: [{ id: 'AC-1', statement: 'The route follows the record.' }],
            ownedPaths: ['subject.ts'],
            workflowProfile: { version: 1, isolationMode: 'current_worktree', developmentMode: 'tdd', reviewMode: 'strict', comet: { projectInit: 'not_requested', openStatus: 'acknowledged' } },
        });
        await writeFile(join(root, 'subject.ts'), 'export const subject = true;\n');
        const sealed = await sealFixture(root, 'export const subject = true;\n', undefined);
        // The ladder must admit a repair for the class route to be the alternative under test: a major finding at `strict`,
        // bound to the revision in hand.
        await writeFile(reviewPath(root, taskId), `${JSON.stringify({
            revisionId: sealed.id,
            manifestHash: sealed.manifestHash,
            status: 'pending',
            findings: [{ id: 'M-1', taskId, severity: 'major', message: 'a class recurring inside its own repair' }],
        })}\n`);
        await writeFile(reviewRoundsPath(root, taskId), [
            JSON.stringify({
                at: '2026-01-01T00:00:00.000Z', revisionId: sealed.id, manifestHash: sealed.manifestHash,
                blockingIds: ['F-1'], blockingCount: 1,
                findings: [{ id: 'F-1', severity: 'major', class: 'instrument-unsound', origin: 'original' }],
            }),
            JSON.stringify({
                at: '2026-01-02T00:00:00.000Z', revisionId: sealed.id, manifestHash: sealed.manifestHash,
                blockingIds: ['F-2'], blockingCount: 1,
                findings: [{ id: 'F-2', severity: 'major', class: 'instrument-unsound', origin: 'repair' }],
            }),
        ].join('\n') + '\n');

        const summary = await readUpstreamSummary(root, taskId);

        expect(summary.reviewExitDue).toBeUndefined();
        expect(suggestCandidateAction('review', summary)).toMatchObject({ nextSkill: '/kata-build', reason: 'review_class_recurring' });
    });

    it('reads occurrences from the rounds, with the revision and the authorship the ordering needs', () => {
        const rounds: ReviewRound[] = [
            {
                at: '2026-01-01T00:00:00.000Z', revisionId: 'revision-a', manifestHash: 'm'.repeat(64),
                blockingIds: ['F-1'], blockingCount: 1,
                findings: [{ id: 'F-1', severity: 'major', class: 'instrument-unsound', origin: 'original' }],
            },
            {
                at: '2026-01-02T00:00:00.000Z', revisionId: 'revision-b', manifestHash: 'm'.repeat(64),
                blockingIds: ['F-2'], blockingCount: 1,
                findings: [
                    { id: 'F-2', severity: 'major', class: 'instrument-unsound', origin: 'repair' },
                    { id: 'F-3', severity: 'minor', origin: 'repair' },
                ],
            },
        ];

        expect(classOccurrences(rounds)).toEqual([
            { defectClass: 'instrument-unsound', roundAt: '2026-01-01T00:00:00.000Z', revisionId: 'revision-a', origin: 'original' },
            { defectClass: 'instrument-unsound', roundAt: '2026-01-02T00:00:00.000Z', revisionId: 'revision-b', origin: 'repair' },
        ]);
    });
});

/**
 * Seal one revision of the fixture's subject, and answer the identity the round records bind to.
 *
 * The identity matters: a round row and a review record are read against the sealed revision, so a fixture that invented a
 * hash would leave the ladder seeing nothing and the route would answer "record a conclusion" instead of the state under
 * test. The change record is written because the repair chain is derived from it — `baseRevisionId` is what makes two
 * revisions one chain, and therefore what makes "a repair was sealed in between" a fact rather than a timestamp guess.
 */
async function sealFixture(root: string, content: string, baseRevisionId: string | undefined): Promise<{ id: string; manifestHash: string }> {
    await writeFile(join(root, 'subject.ts'), content);
    const sealed = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: ['test'] });
    const record = await buildChangeRecord({
        root,
        taskId,
        revisionId: sealed.revision.id,
        ...(baseRevisionId === undefined ? {} : { baseRevisionId }),
        ownedPaths: ['subject.ts'],
        evidence: [{ id: 'evidence-1', checkId: 'test', exitCode: 0, passed: true }],
        claimFailures: [],
        findings: [],
        ...(sealed.revision.contentDigests ? { contentDigests: sealed.revision.contentDigests } : {}),
    });
    const written = await writeChangeRecord(root, taskId, record);
    if (typeof written !== 'string') throw new Error(`the change record was refused: ${written.refused.join('; ')}`);
    return { id: sealed.revision.id, manifestHash: sealed.revision.manifestHash };
}
