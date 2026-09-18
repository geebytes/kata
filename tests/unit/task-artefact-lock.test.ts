import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { acknowledgeCometOpen, updateGitFlowProfile } from '../../src/core/workflow-profile.js';
import { persistBlockingFindings } from '../../src/quality/repair-obligations.js';

/**
 * Task-scoped artefacts are mutated under the task lock (L3-09).
 *
 * `withTaskLock` guarded two call sites — the state transition and the review-repair re-entry — while `task.json`,
 * `review.json` and `repair-obligations.json` were rewritten by unlocked read-modify-writes. Two commands on one task
 * could therefore lose an update in exactly the files that carry the review and judge bindings. The observable property
 * is that a mutation holds the lock while it reads: a second mutation overlapping it is refused rather than silently
 * interleaved.
 */
describe('task-scoped artefact mutations take the task lock', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function workspace(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-artefact-lock-'));
        roots.push(root);
        await initLayout(root);
        await createTask({
            root,
            id: 'locked-task',
            title: 'Locked artefacts',
            acceptance: [{ id: 'AC-1', statement: 'Mutations are serialized.' }],
        });
        return root;
    }

    it('writes workflow-profile changes through the lock and keeps the rest of task.json', async () => {
        const root = await workspace();
        await acknowledgeCometOpen(root, 'locked-task');
        const afterAck = JSON.parse(await readFile(join(root, '.kata/tasks/locked-task/task.json'), 'utf8')) as {
            workflowProfile?: { comet?: { openStatus?: string } };
        };
        expect(afterAck.workflowProfile?.comet?.openStatus).toBe('acknowledged');

        // A locked write holds the lock directory while it runs, so it cannot interleave with another one.
        const lockPath = join(root, '.kata/tasks/locked-task/.transition.lock');
        await (await import('node:fs/promises')).mkdir(lockPath, { recursive: true });
        await expect(updateGitFlowProfile(root, 'locked-task', { strategy: 'manual', branch: 'kata/x', baseBranch: 'master', status: 'active' }))
            .rejects.toThrow(/already has a state transition in progress/);
        await rm(lockPath, { recursive: true, force: true });

        // And the write lands atomically once the lock is free, leaving fields it did not touch alone.
        await updateGitFlowProfile(root, 'locked-task', { strategy: 'manual', branch: 'kata/x', baseBranch: 'master', status: 'active' });
        const task = JSON.parse(await readFile(join(root, '.kata/tasks/locked-task/task.json'), 'utf8')) as {
            title?: string;
            workflowProfile?: { gitFlow?: { branch?: string } };
        };
        expect(task.title).toBe('Locked artefacts');
        expect(task.workflowProfile?.gitFlow?.branch).toBe('kata/x');
    });

    it('serializes obligation writes instead of dropping one', async () => {
        const root = await workspace();
        // Sequential, so both land — the lock's job is to make the read-modify-write indivisible, not to lose one.
        await persistBlockingFindings(root, 'locked-task', [{ id: 'f-1', severity: 'blocking', message: 'first' }]);
        const second = await persistBlockingFindings(root, 'locked-task', [{ id: 'f-2', severity: 'blocking', message: 'second' }]);

        // One of the two may be refused while the other holds the lock — that is the point — and whichever lands must
        // not have silently overwritten the other's read.
        const record = JSON.parse(await readFile(join(root, '.kata/tasks/locked-task/repair-obligations.json'), 'utf8')) as {
            obligations: Array<{ findingId?: string }>;
        };
        // The second write appended: the first obligation is still there, which is what an unlocked read-modify-write
        // could have dropped.
        expect(record.obligations.map((entry) => entry.findingId).filter(Boolean)).toEqual(['f-1', 'f-2']);
        expect(second.map((entry) => entry.findingId)).toEqual(['f-2']);
    });
});
