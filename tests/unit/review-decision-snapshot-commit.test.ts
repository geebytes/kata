import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { appendReviewRound, readReviewRoundsState } from '../../src/quality/repair.js';
import { mutateTaskArtefact } from '../../src/core/state.js';
import { authorizeReviewRepair } from '../../src/workflow/repair-entry.js';
import {
    commitReviewDecision,
    createTaskRevisionIfChanged,
    readReviewDecisionSnapshot,
    reviewDecisionSnapshotMatches,
} from '../../src/workflow/revision.js';


const forceMovedCommit = vi.hoisted(() => ({ value: false }));
vi.mock('../../src/workflow/revision.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../../src/workflow/revision.js')>();
    return {
        ...original,
        commitReviewDecision: async (...args: any[]) => forceMovedCommit.value
            ? { kind: 'moved', current: { kind: 'absent' } }
            : original.commitReviewDecision(args[0], args[1], args[2], args[3]),
    };
});
const roots: string[] = [];

async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-review-decision-snapshot-'));
    roots.push(root);
    await initLayout(root);
    return root;
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
afterEach(() => {
    forceMovedCommit.value = false;
});

describe('review decision snapshots', () => {
    it('refuses to commit an A decision after the sealed pointer moves to B', async () => {
        const root = await tempRoot();
        const taskId = 'review-decision-snapshot-moved';
        await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
        await writeFile(join(root, 'subject.ts'), 'export const version = "A";\n');
        const revisionA = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: [] });
        const snapshot = await readReviewDecisionSnapshot(root, taskId);

        await writeFile(join(root, 'subject.ts'), 'export const version = "B";\n');
        const revisionB = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: [] });
        expect(revisionB.revision.id).not.toBe(revisionA.revision.id);

        let wrote = false;
        const committed = await commitReviewDecision(root, taskId, snapshot, async () => {
            wrote = true;
        });

        expect(committed).toMatchObject({ kind: 'moved' });
        expect(wrote).toBe(false);
    });
    it('treats a manifest change as moved even when the revision id is unchanged', () => {
        const expected = {
            kind: 'current' as const,
            revision: {
                id: 'revision-same',
                taskId: 'snapshot-comparator',
                ownedPaths: ['subject.ts'],
                manifestHash: 'a'.repeat(64),
                createdAt: '2026-10-05T00:00:00.000Z',
            },
        };
        const current = {
            kind: 'current' as const,
            revision: {
                id: 'revision-same',
                taskId: 'snapshot-comparator',
                ownedPaths: ['subject.ts'],
                manifestHash: 'b'.repeat(64),
                createdAt: '2026-10-05T00:00:00.000Z',
            },
        };

        expect(reviewDecisionSnapshotMatches(expected, current)).toBe(false);
    });


    it('refuses an absent pointer without executing a review decision', async () => {
        const root = await tempRoot();
        const taskId = 'review-decision-snapshot-absent';
        await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
        const snapshot = await readReviewDecisionSnapshot(root, taskId);

        let wrote = false;
        const committed = await commitReviewDecision(root, taskId, snapshot, async () => {
            wrote = true;
        });

        expect(committed).toMatchObject({ kind: 'missing' });
        expect(wrote).toBe(false);
    });


    it('does not append a repair round when its commit snapshot has moved', async () => {
        const root = await tempRoot();
        const taskId = 'review-decision-snapshot-repair';
        await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
        await writeFile(join(root, 'subject.ts'), 'export const version = "A";\n');
        await writeFile(join(root, '.kata', 'tasks', taskId, 'task.json'), `${JSON.stringify({
            id: taskId,
            title: 'T',
            phase: 'review',
            acceptance: [{ id: 'AC-1', statement: 'x' }],
            ownedPaths: ['subject.ts'],
            createdAt: '2026-10-05T00:00:00.000Z',
            updatedAt: '2026-10-05T00:00:00.000Z',
        })}\n`);
        const sealed = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: [] });
        await writeFile(join(root, '.kata', 'tasks', taskId, 'review.json'), `${JSON.stringify({
            revisionId: sealed.revision.id,
            manifestHash: sealed.revision.manifestHash,
            status: 'pending',
            findings: [{ id: 'F-1', taskId, severity: 'blocking', message: 'must repair' }],
        })}\n`);
        forceMovedCommit.value = true;

        const authorization = await authorizeReviewRepair(root, taskId);

        expect(authorization).toMatchObject({ authorized: false });
        expect((await readReviewRoundsState(root, taskId)).rounds).toHaveLength(0);
    });



    it('commits a round under the same lock that validated its snapshot', async () => {
        const root = await tempRoot();
        const taskId = 'review-decision-snapshot-commit';
        await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
        await writeFile(join(root, 'subject.ts'), 'export const version = "A";\n');
        const sealed = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: [] });
        const snapshot = await readReviewDecisionSnapshot(root, taskId);

        const committed = await commitReviewDecision(root, taskId, snapshot, async (lock) => {
            await appendReviewRound(root, taskId, {
                at: '2026-10-05T00:00:00.000Z',
                revisionId: sealed.revision.id,
                manifestHash: sealed.revision.manifestHash,
                blockingIds: ['F-1'],
                blockingCount: 1,
            }, lock);
        });

        expect(committed).toMatchObject({ kind: 'committed' });
        expect((await readReviewRoundsState(root, taskId)).rounds).toHaveLength(1);
    });

    it('mutates a review artefact under the same lock that validated its snapshot', async () => {
        const root = await tempRoot();
        const taskId = 'review-decision-snapshot-artefact';
        const record = join(root, '.kata', 'tasks', taskId, 'review.json');
        await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
        await writeFile(join(root, 'subject.ts'), 'export const version = "A";\n');
        await writeFile(record, '{}\n');
        await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: [] });
        const snapshot = await readReviewDecisionSnapshot(root, taskId);

        const committed = await commitReviewDecision(root, taskId, snapshot, async (lock) => {
            await mutateTaskArtefact(root, taskId, record, async () => '{"status":"pending"}\n', lock);
        });

        expect(committed).toMatchObject({ kind: 'committed' });
        await expect(readFile(record, 'utf8')).resolves.toBe('{"status":"pending"}\n');
    });
});
