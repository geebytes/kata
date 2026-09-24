import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask, readTask } from '../../src/core/task.js';
import { runMatrixCommand } from '../../src/cli/matrix.js';

/**
 * `ownedPaths` has a governed correction, and it is the fifth of one gap.
 *
 * Declared at `open` and changeable never after — while selector, statement and implementation path each got a command, and the
 * absence of this one forced the unverifiable write (`task.json` by hand) the platform exists to remove. Measured while scoping
 * a change whose every needed file belonged to a *different* change: two active changes whose ownedPaths overlap make each other's
 * revisions `superseded`, so a declaration that cannot be corrected is a deadlock rather than an inconvenience.
 *
 * And it is a **task-level** field, not a row of the matrix — which is why its branch runs before the per-row guard. My first
 * version put it after, and the command refused a correction that named no acceptance id; that is the defect this case exists to
 * pin, because "the flag exists" and "the flag can be used" are two different claims.
 */
const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('an owned-path correction is reachable', () => {
    it('corrects the declaration without naming an acceptance id, and reports the previous set', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-owned-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'o-task', title: 'Owned', acceptance: [{ id: 'AC-1', statement: 'x' }] });

        const before = (await readTask(root, 'o-task')).ownedPaths ?? [];
        const result = await runMatrixCommand(
            ['set', '--change', 'o-task', '--owned-paths', 'src/a.ts,src/b.ts', '--reason', 'the work moved'],
            root,
        );
        expect(result.updated).toBe(true);
        // **No --acceptance**, which is the case that was refused when the branch sat after the per-row guard.
        expect(result.error).toBeUndefined();
        expect(result.previousPaths).toEqual(before);
        expect((await readTask(root, 'o-task')).ownedPaths).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('refuses a correction that escapes the repository, for the reason open refuses it', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-owned-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'o-task', title: 'Owned', acceptance: [{ id: 'AC-1', statement: 'x' }] });
        const before = (await readTask(root, 'o-task')).ownedPaths ?? [];
        const result = await runMatrixCommand(
            ['set', '--change', 'o-task', '--owned-paths', '../outside.ts', '--reason', 'escapes'],
            root,
        );
        // Normalized through the same resolver `open` uses, so an escaping path cannot enter the declaration here.
        expect(result.updated).toBe(false);
        expect(String(result.error)).toContain('inside the repository');
        // The task's declared set is unchanged by a refused correction — whatever `createTask` defaulted it to.
        // A refused correction writes nothing at all, which is what `task.ownedPaths` being undefined says: `createTask` never
        // declared one, and the refusal must not have introduced one.
        expect((await readTask(root, 'o-task')).ownedPaths).toEqual(before.length > 0 ? before : undefined);
    });
});
