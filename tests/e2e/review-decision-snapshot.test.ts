import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const moveAfterSnapshot = vi.hoisted(() => ({ enabled: false, moved: false }));
vi.mock('../../src/workflow/revision.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../../src/workflow/revision.js')>();
    return {
        ...original,
        readReviewDecisionSnapshot: async (...args: Parameters<typeof original.readReviewDecisionSnapshot>) => {
            const snapshot = await original.readReviewDecisionSnapshot(...args);
            if (moveAfterSnapshot.enabled && !moveAfterSnapshot.moved) {
                moveAfterSnapshot.moved = true;
                const [root, taskId] = args;
                await writeFile(join(root, 'task-owned.txt'), 'sealed implementation B\n');
                await original.createTaskRevisionIfChanged({
                    root,
                    taskId,
                    ownedPaths: ['task-owned.txt'],
                    checkIds: [],
                });
            }
            return snapshot;
        },
    };
});

const { initLayout, reviewPath } = await import('../../src/core/layout.js');
const { runCommand } = await import('../../src/workflow/orchestrator.js');

const roots: string[] = [];

async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-review-decision-entrypoint-'));
    roots.push(root);
    await initLayout(root);
    return root;
}

afterEach(async () => {
    moveAfterSnapshot.enabled = false;
    moveAfterSnapshot.moved = false;
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('review decision snapshot workflow', () => {
    it('refuses to write a review decision after A is superseded by B before commit', async () => {
        const root = await tempRoot();
        const taskId = 'review-decision-entrypoint-moved';
        await runCommand('open', taskId, root, {
            acceptance: [{ id: 'AC-1', statement: 'Review decisions are revision bound.' }],
        });
        await runCommand('design', taskId, root);
        await writeFile(join(root, 'task-owned.txt'), 'sealed implementation A\n');
        await runCommand('build', taskId, root, {
            ownedPaths: ['task-owned.txt'],
            checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
        });

        moveAfterSnapshot.enabled = true;
        const result = await runCommand('review', taskId, root, { confirmHostModel: true });

        expect(moveAfterSnapshot.moved).toBe(true);
        expect(result).toMatchObject({
            command: 'review',
            success: false,
            error: expect.stringMatching(/sealed revision moved|became unavailable/i),
        });
        await expect(readFile(reviewPath(root, taskId), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
