import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout, reviewPath } from '../../src/core/layout.js';
import { buildChangeRecord, writeChangeRecord } from '../../src/quality/change-record.js';
import { reviewRoundsPath } from '../../src/quality/repair.js';
import { readLoopState } from '../../src/quality/repair-lineage.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';

/**
 * **A round kind is a state, so it needs an exit — and the first version gave both kinds none.**
 *
 * `root_cause` was returned whenever the recurrence packet fired. The packet is derived from the whole round history, so it
 * went on firing after a round had answered it: every later round was dispatched to produce a conclusion a previous round had
 * already written, and the `resume_certification` next-action the vocabulary defines was unreachable from a request.
 *
 * `focused_followup` was returned whenever *any* earlier revision of the chain had recorded a finding. That is a sentence
 * about history, and history does not stop being true: a clean follow-up verified the repair, closed the batch, and the next
 * round was still told to verify it.
 *
 * A kind with no exit is a loop with no end — which is what was measured: eight rounds, none of them a follow-up, and no
 * state from which the chain could be called converged. These cases pin the three states and both transitions out of them.
 */
const taskId = 'a-round-kind';

const obligation = {
    states: ['the class is decided per site', 'the class is decided by one derivation'],
    sourceOfTruth: 'theOneDerivation',
    inventory: ['src/a.ts:10'],
    invariant: 'every site asks the one derivation',
    repairSurface: ['src/a.ts'],
    effectivenessTest: 'tests/unit/a.test.ts',
    ifRecursAgain: 'rewrite_mechanism' as const,
};

describe('a round kind has an exit, and the batch is the object it names', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    /** A task with `count` sealed revisions, each one written on top of the last, so the chain is real. */
    async function fixture(count: number): Promise<{ root: string; revisions: string[] }> {
        const root = await mkdtemp(join(tmpdir(), 'kata-round-kind-'));
        roots.push(root);
        await initLayout(root);
        await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
        await writeFile(join(root, '.kata', 'tasks', taskId, 'task.json'), `${JSON.stringify({
            id: taskId,
            title: 'A round kind has an exit',
            acceptance: [{ id: 'AC-1', statement: 'x' }],
            ownedPaths: ['subject.ts'],
            workflowProfile: { reviewMode: 'strict' },
        })}\n`);
        const revisions: string[] = [];
        let base: string | undefined;
        for (let index = 0; index < count; index += 1) {
            await writeFile(join(root, 'subject.ts'), `export const subject = ${index};\n`);
            const sealed = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: ['test'] });
            const record = await buildChangeRecord({
                root,
                taskId,
                revisionId: sealed.revision.id,
                ...(base === undefined ? {} : { baseRevisionId: base }),
                ownedPaths: ['subject.ts'],
                evidence: [{ id: 'evidence-1', checkId: 'test', exitCode: 0, passed: true }],
                claimFailures: [],
                findings: [],
                ...(sealed.revision.contentDigests ? { contentDigests: sealed.revision.contentDigests } : {}),
            });
            const written = await writeChangeRecord(root, taskId, record);
            if (typeof written !== 'string') throw new Error(`the change record was refused: ${written.refused.join('; ')}`);
            revisions.push(sealed.revision.id);
            base = sealed.revision.id;
        }
        return { root, revisions };
    }

    const roundRow = (fields: Record<string, unknown>): string => `${JSON.stringify(fields)}\n`;

    it('closes the batch when a follow-up comes back clean, instead of following it up forever', async () => {
        const { root, revisions } = await fixture(2);
        // The round that found problems on the first revision, and the repair that followed it.
        const findingRound = { id: 'F-1', severity: 'major', class: 'instrument-unsound', origin: 'original' };
        await writeFile(reviewRoundsPath(root, taskId), roundRow({
            at: '2026-01-01T00:00:00.000Z', revisionId: revisions[0], kind: 'certification',
            blockingIds: ['F-1'], blockingCount: 1, findings: [findingRound],
        }));

        const followingUp = await readLoopState({ root, taskId, currentRevisionId: revisions[1] });
        expect(followingUp.kind).toBe('focused_followup');
        // **The object the word was missing.** Which round, which findings, which revisions — and what the round does not have
        // to re-open. Without these a reviewer can only re-read everything, which is the behaviour the loop was stuck on.
        expect(followingUp.batch).toMatchObject({ roundAt: '2026-01-01T00:00:00.000Z', revisionId: revisions[0] });
        expect(followingUp.batch?.findings.map((finding) => finding.id)).toEqual(['F-1']);

        // The follow-up came back clean: nothing was asked for, so there is nothing to follow up, and the chain is back in the
        // state where a round owns the whole revision. This is the exit the first version did not have.
        await writeFile(reviewRoundsPath(root, taskId), [
            roundRow({
                at: '2026-01-01T00:00:00.000Z', revisionId: revisions[0], kind: 'certification',
                blockingIds: ['F-1'], blockingCount: 1, findings: [findingRound],
            }),
            roundRow({
                at: '2026-01-02T00:00:00.000Z', revisionId: revisions[1], kind: 'focused_followup',
                blockingIds: [], blockingCount: 0,
            }),
        ].join(''));

        const afterCleanFollowup = await readLoopState({ root, taskId, currentRevisionId: revisions[1] });
        expect(afterCleanFollowup.kind).toBe('certification');
        expect(afterCleanFollowup.batch).toBeNull();
    });

    it('asks a root-cause question once, and then hands the repair to a follow-up', async () => {
        const { root, revisions } = await fixture(2);
        await writeFile(reviewRoundsPath(root, taskId), [
            roundRow({
                at: '2026-01-01T00:00:00.000Z', revisionId: revisions[0],
                blockingIds: ['F-1'], blockingCount: 1,
                findings: [{ id: 'F-1', severity: 'major', class: 'instrument-unsound', origin: 'original' }],
            }),
            roundRow({
                at: '2026-01-02T00:00:00.000Z', revisionId: revisions[0], kind: 'root_cause',
                blockingIds: ['F-2'], blockingCount: 1,
                findings: [{ id: 'F-2', severity: 'major', class: 'instrument-unsound', origin: 'repair' }],
            }),
        ].join(''));
        // The conclusion that round wrote, about the revision it read.
        await writeFile(reviewPath(root, taskId), `${JSON.stringify({
            revisionId: revisions[0],
            reviewedRevisionId: revisions[0],
            recordedAt: '2026-01-02T00:00:00.000Z',
            reviewKind: 'root_cause',
            recurrenceAnalysis: {
                triggerClasses: ['instrument-unsound'],
                conclusion: 'instrument_unsound',
                evidence: ['review-rounds.jsonl:1-2'],
                nextAction: 'repair',
                closureObligation: obligation,
            },
            findings: [],
            status: 'pending',
        })}\n`);

        // **The transition the vocabulary promised and the code could not reach.** The packet still fires (it is derived from
        // the whole history), but a conclusion has been recorded at this revision, so the next round verifies the repair that
        // conclusion contracted rather than producing the conclusion again.
        const afterConclusion = await readLoopState({ root, taskId, currentRevisionId: revisions[0] });
        expect(afterConclusion.kind).toBe('certification');

        // And once the repair is sealed, the same packet hands over to the follow-up of that repair.
        const afterRepair = await readLoopState({ root, taskId, currentRevisionId: revisions[1] });
        expect(afterRepair.kind).toBe('focused_followup');
        expect(afterRepair.batch?.revisionId).toBe(revisions[0]);
    });

    it('stops asking about a class a round has answered, until it occurs again', async () => {
        const { root, revisions } = await fixture(1);
        await writeFile(reviewRoundsPath(root, taskId), roundRow({
            at: '2026-01-01T00:00:00.000Z', revisionId: revisions[0],
            blockingIds: ['F-1'], blockingCount: 1,
            findings: [{ id: 'F-1', severity: 'major', class: 'instrument-unsound', origin: 'original' }],
        }));
        await writeFile(reviewPath(root, taskId), `${JSON.stringify({
            revisionId: revisions[0],
            reviewedRevisionId: revisions[0],
            recordedAt: '2026-01-02T00:00:00.000Z',
            recurrenceAnalysis: {
                triggerClasses: ['instrument-unsound'],
                conclusion: 'not_same_class',
                evidence: ['review-rounds.jsonl:1'],
                nextAction: 'resume_certification',
            },
            findings: [],
            status: 'pending',
        })}\n`);

        // `not_same_class` answers the class question, so the packet must stop raising that class: this is what the request
        // and the result both filter on, and the reason `resume_certification` is reachable at all.
        expect((await readLoopState({ root, taskId, currentRevisionId: revisions[0] })).clearedClasses)
            .toEqual(['instrument-unsound']);
    });

    it('names an unreadable chain instead of reporting that the task never repaired', async () => {
        const { root, revisions } = await fixture(2);
        // A change record that cannot be parsed is a chain that cannot be walked — a different fact from a task that has one
        // revision, and one a reader has to repair rather than read as a young chain.
        await writeFile(join(root, '.kata', 'tasks', taskId, `change-record-${revisions[1]}.json`), '{');

        const state = await readLoopState({ root, taskId, currentRevisionId: revisions[1] });

        expect(state.lineageUnreadable).toContain('change-record');
        expect(state.chain).toEqual([]);
    });
});
