import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { buildChangeRecord, writeChangeRecord } from '../../src/quality/change-record.js';
import { reviewRoundsPath, type ReviewRound } from '../../src/quality/repair.js';
import { deriveReviewKind, lineageProgress, readRepairLineage } from '../../src/quality/repair-lineage.js';
import { readUpstreamSummary, suggestCandidateAction } from '../../src/workflow/navigation.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';

/**
 * **The reading the revision-scoped count cannot produce, and the reason the loop never ended.**
 *
 * Every repair seals a new revision, and `assessReviewLoop` scopes its rounds to the current revision — correctly, because a
 * round about other content is not a reading of this content. The consequence measured on `the-gates-can-be-repaired`: eight
 * rounds, eight distinct revision ids, and a revision-scoped `noProgressRounds` that never exceeded 1, so the escalation
 * that needs three could not fire no matter how long the loop ran.
 *
 * The chain is derived from the change records the seal already writes (`revisionId` + `baseRevisionId`), so there is no new
 * field to forget, and the arithmetic is `reviewProgress` — the same function — over the chain's rounds.
 */
const taskId = 'a-repair-chain';

async function fixture(): Promise<{ root: string; revisions: string[] }> {
    const root = await mkdtemp(join(tmpdir(), 'kata-repair-chain-'));
    await initLayout(root);
    await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
    await writeFile(join(root, '.kata', 'tasks', taskId, 'task.json'), `${JSON.stringify({
        id: taskId,
        title: 'A repair chain is the unit of convergence',
        acceptance: [{ id: 'AC-1', statement: 'x' }],
        ownedPaths: ['subject.ts'],
        workflowProfile: { reviewMode: 'strict' },
    })}\n`);
    const revisions: string[] = [];
    let base: string | undefined;
    for (let index = 0; index < 4; index += 1) {
        // Each repair writes new content, so each seal mints a new revision — and the seal writes the change record that
        // names the revision it was sealed on top of. The fixture writes the same record the seal writes, because the chain
        // is derived from those records rather than from a field a test could invent.
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

function roundAt(revisionId: string, at: string, blockingCount: number, findings: ReviewRound['findings']): ReviewRound {
    return {
        at,
        revisionId,
        manifestHash: 'm'.repeat(64),
        blockingIds: (findings ?? []).map((finding) => finding.id),
        blockingCount,
        ...(findings === undefined ? { noFindings: 'nothing was recorded for this round' } : { findings }),
    };
}

describe('a repair chain is the unit of convergence', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    it('walks the change records back to the revision the chain started on, oldest first', async () => {
        const { root, revisions } = await fixture();
        roots.push(root);

        const lineage = await readRepairLineage(root, taskId, revisions[3]);

        expect(lineage.kind).toBe('usable');
        if (lineage.kind !== 'usable') throw new Error('unreachable');
        expect(lineage.chain.map((link) => link.revisionId)).toEqual(revisions);
        expect(lineage.rootRevisionId).toBe(revisions[0]);
    });

    it('counts the whole chain, where the revision-scoped reading counts one revision', async () => {
        const { root, revisions } = await fixture();
        roots.push(root);
        // Four rounds, each bound to a different revision of the chain, none of them reaching a new low: 2, 3, 4, 5.
        const chainRounds = [
            roundAt(revisions[0], '2026-01-01T00:00:00.000Z', 2, []),
            roundAt(revisions[1], '2026-01-02T00:00:00.000Z', 3, []),
            roundAt(revisions[2], '2026-01-03T00:00:00.000Z', 4, []),
            roundAt(revisions[3], '2026-01-04T00:00:00.000Z', 5, []),
        ];
        await writeFile(reviewRoundsPath(root, taskId), `${chainRounds.map((round) => JSON.stringify(round)).join('\n')}\n`);

        const lineage = await readRepairLineage(root, taskId, revisions[3]);
        if (lineage.kind !== 'usable') throw new Error('unreachable');
        const measured = lineageProgress(lineage, chainRounds);

        expect({ revisions: measured.revisions }, 'the chain the reading judged').toEqual({ revisions });
        expect(measured.singleRevision).toBe(false);
        // Four rounds without a new low, across four revisions: the stop line the revision-scoped reading cannot reach (each
        // of those revisions holds one round, so the revision-scoped run is never longer than 1).
        expect({ rounds: measured.progress.rounds }, 'every round of the chain participates').toEqual({ rounds: 4 });
        expect(measured.progress.noProgressRounds).toBe(3);
        expect(measured.progress.escalating).toBe(true);
    });

    it('routes the chain to the terminal escalation, where the revision-scoped reading says there is no round at all', async () => {
        const { root, revisions } = await fixture();
        roots.push(root);
        await writeFile(reviewRoundsPath(root, taskId), [
            JSON.stringify(roundAt(revisions[0], '2026-01-01T00:00:00.000Z', 2, [{ id: 'F-1', severity: 'major' }])),
            JSON.stringify(roundAt(revisions[1], '2026-01-02T00:00:00.000Z', 3, [{ id: 'F-2', severity: 'major' }])),
            JSON.stringify(roundAt(revisions[2], '2026-01-03T00:00:00.000Z', 4, [{ id: 'F-3', severity: 'major' }])),
            JSON.stringify(roundAt(revisions[3], '2026-01-04T00:00:00.000Z', 5, [{ id: 'F-4', severity: 'major' }])),
        ].join('\n') + '\n');

        const summary = await readUpstreamSummary(root, taskId);

        // The revision-scoped reading cannot see the loop at all: the rounds on disk carry no manifest hash for the revision
        // in hand, so `assessReviewLoop` answers that nothing has been measured about it — which is exactly the state a repair
        // produces, four times over.
        expect(summary.reviewLoop?.kind).toBe('no_current_rounds');
        expect(summary.reviewLineage).toMatchObject({ rounds: 4, noProgressRounds: 3, stalled: true });
        expect(summary.reviewLineage?.revisions).toEqual(revisions);
        // And the route out of that state is the terminal decision, not another review round.
        expect(suggestCandidateAction('review', summary)).toMatchObject({
            reason: 'escalate_review_without_progress',
            nextSkill: '/kata',
            role: 'dispatcher',
        });
    });

    it('does not escalate a chain that is still reaching new lows', async () => {
        const { root, revisions } = await fixture();
        roots.push(root);
        await writeFile(reviewRoundsPath(root, taskId), [
            JSON.stringify(roundAt(revisions[0], '2026-01-01T00:00:00.000Z', 5, [{ id: 'F-1', severity: 'major' }])),
            JSON.stringify(roundAt(revisions[1], '2026-01-02T00:00:00.000Z', 3, [{ id: 'F-2', severity: 'major' }])),
            JSON.stringify(roundAt(revisions[2], '2026-01-03T00:00:00.000Z', 1, [{ id: 'F-3', severity: 'major' }])),
            JSON.stringify(roundAt(revisions[3], '2026-01-04T00:00:00.000Z', 0, [{ id: 'F-4', severity: 'major' }])),
        ].join('\n') + '\n');

        const summary = await readUpstreamSummary(root, taskId);

        expect(summary.reviewLineage?.stalled).toBe(false);
        expect(suggestCandidateAction('review', summary).reason).not.toBe('escalate_review_without_progress');
    });

    it('is not a lineage when the chain is one revision, and says so instead of reporting a verdict', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-repair-chain-one-'));
        roots.push(root);
        await initLayout(root);
        await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
        await writeFile(join(root, '.kata', 'tasks', taskId, 'task.json'), `${JSON.stringify({
            id: taskId,
            title: 'one revision',
            acceptance: [{ id: 'AC-1', statement: 'x' }],
            ownedPaths: ['subject.ts'],
            workflowProfile: { reviewMode: 'strict' },
        })}\n`);
        await writeFile(join(root, 'subject.ts'), 'export const subject = true;\n');
        const sealed = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: ['test'] });
        await writeFile(reviewRoundsPath(root, taskId), `${JSON.stringify(roundAt(sealed.revision.id, '2026-01-01T00:00:00.000Z', 1, [{ id: 'F-1', severity: 'major' }]))}\n`);

        const summary = await readUpstreamSummary(root, taskId);

        expect(summary.reviewLineage).toBeUndefined();
    });

    it('names an unreadable chain rather than reporting that no lineage exists', async () => {
        const { root, revisions } = await fixture();
        roots.push(root);
        // A change record that cannot be parsed is a chain that cannot be walked, which is a different fact from a task that
        // never repaired. Folding them together would report "one revision" for a chain that is four seals long.
        await writeFile(join(root, '.kata', 'tasks', taskId, `change-record-${revisions[1]}.json`), '{');

        const summary = await readUpstreamSummary(root, taskId);

        expect(summary.lineageUnreadable).toContain('change-record');
        expect(summary.reviewLineage).toBeUndefined();
    });

    /**
     * **Which activity a round is, derived rather than chosen.**
     *
     * Without the word, every round after a repair carried the same "review this change" brief, and the defensible reading of
     * that brief is the widest one — so a follow-up re-found a defect in the repair it was sent to verify, in every round.
     */
    it('derives the round kind from the chain and the history, not from a caller', async () => {
        const { root, revisions } = await fixture();
        roots.push(root);
        const lineage = await readRepairLineage(root, taskId, revisions[3]);
        if (lineage.kind !== 'usable') throw new Error('unreachable');

        // Nothing reviewed on this chain yet: the round owns the whole revision.
        expect(deriveReviewKind({
            recurrencePacketFired: false,
            recurrenceAlreadyDeclared: false,
            lineage,
            currentRevisionId: revisions[3],
            rounds: [],
        })).toBe('certification');

        // An earlier revision of the chain recorded findings: there is a repair batch to verify.
        const earlierBatch = [roundAt(revisions[0], '2026-01-01T00:00:00.000Z', 2, [{ id: 'F-1', severity: 'major' }])];
        expect(deriveReviewKind({
            recurrencePacketFired: false,
            recurrenceAlreadyDeclared: false,
            lineage,
            currentRevisionId: revisions[3],
            rounds: earlierBatch,
        })).toBe('focused_followup');

        // A round with no findings is not a batch: nothing was asked for, so nothing is being followed up.
        const cleared = [roundAt(revisions[0], '2026-01-01T00:00:00.000Z', 0, [])];
        expect(deriveReviewKind({
            recurrencePacketFired: false,
            recurrenceAlreadyDeclared: false,
            lineage,
            currentRevisionId: revisions[3],
            rounds: cleared,
        })).toBe('certification');

        // Only this revision's own rounds are on record: the chain has been repaired but not yet reviewed, so this round is
        // still the first scope statement about the content in hand.
        const ownOnly = [roundAt(revisions[3], '2026-01-04T00:00:00.000Z', 1, [{ id: 'F-9', severity: 'major' }])];
        expect(deriveReviewKind({
            recurrencePacketFired: false,
            recurrenceAlreadyDeclared: false,
            lineage,
            currentRevisionId: revisions[3],
            rounds: ownOnly,
        })).toBe('certification');

        // The recurrence packet fired: the round's job is the cause, not another certification.
        expect(deriveReviewKind({
            recurrencePacketFired: true,
            recurrenceAlreadyDeclared: false,
            lineage,
            currentRevisionId: revisions[3],
            rounds: earlierBatch,
        })).toBe('root_cause');
    });

    it('records the kind on the round rows and counts them where the loop is measured', async () => {
        const { root, revisions } = await fixture();
        roots.push(root);
        await writeFile(reviewRoundsPath(root, taskId), [
            JSON.stringify({ ...roundAt(revisions[0], '2026-01-01T00:00:00.000Z', 2, [{ id: 'F-1', severity: 'major' }]), kind: 'certification' }),
            JSON.stringify({ ...roundAt(revisions[1], '2026-01-02T00:00:00.000Z', 1, [{ id: 'F-2', severity: 'major' }]), kind: 'focused_followup' }),
            JSON.stringify({ ...roundAt(revisions[2], '2026-01-03T00:00:00.000Z', 1, [{ id: 'F-3', severity: 'major' }]), kind: 'focused_followup' }),
        ].join('\n') + '\n');

        const summary = await readUpstreamSummary(root, taskId);

        // Eight certifications and no follow-up is the reading that says a loop was never scoped to converge; `undeclared`
        // counts rows written before the field existed rather than attributing them to a kind a reader would have preferred.
        expect(summary.reviewLoopReplay?.roundsByKind).toEqual({ certification: 1, focused_followup: 2, root_cause: 0, undeclared: 0 });
    });

    it('counts a row with no kind as undeclared rather than as the kind the loop would rather have seen', async () => {
        const { root, revisions } = await fixture();
        roots.push(root);
        await writeFile(reviewRoundsPath(root, taskId), [
            JSON.stringify(roundAt(revisions[0], '2026-01-01T00:00:00.000Z', 2, [{ id: 'F-1', severity: 'major' }])),
            JSON.stringify({ ...roundAt(revisions[1], '2026-01-02T00:00:00.000Z', 1, [{ id: 'F-2', severity: 'major' }]), kind: 'something-else' }),
        ].join('\n') + '\n');

        const summary = await readUpstreamSummary(root, taskId);

        expect(summary.reviewLoopReplay?.roundsByKind).toEqual({ certification: 0, focused_followup: 0, root_cause: 0, undeclared: 2 });
    });
});
