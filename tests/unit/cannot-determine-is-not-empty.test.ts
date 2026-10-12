import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { uniqueCopies, UniqueCopiesUndetermined } from '../../src/core/layout.js';

/**
 * AC-4 — a source that cannot answer is not an empty answer.
 *
 * The measured defect (reading 1, F9): `gitWorktreeList` returned `[]` when it failed, and the enumeration kept only
 * candidates inside the root. Both failure directions produced an **empty set**, and an empty set is exactly the answer
 * that means "nothing would be lost" — so archive could not tell "there is nothing to remove" from "I could not look",
 * and it removed the worktree holding the only copy.
 *
 * The criterion is the distinction, not the mechanism: an unreadable source raises.
 */
const roots: string[] = [];

function repo(name: string): string {
    const root = mkdtempSync(join(tmpdir(), `kata-uc-undet-${name}-`));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), '{ "name": "uc", "private": true }\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) {
        // A case may have removed read permission; restore it so the cleanup can run.
        for (const path of [join(root, '.kata', 'worktrees'), join(root, '.kata', 'worktrees', 'held', '.kata', 'tasks', 'held')]) {
            try {
                chmodSync(path, 0o755);
            } catch {
                // Nothing to restore.
            }
        }
        rmSync(root, { recursive: true, force: true });
    }
});

describe('cannot determine is not empty', () => {
    it('raises when the worktrees directory cannot be read', async () => {
        const primary = repo('unreadable');
        const worktrees = join(primary, '.kata', 'worktrees');
        mkdirSync(worktrees, { recursive: true });
        chmodSync(worktrees, 0o000);

        await expect(uniqueCopies({ root: primary })).rejects.toBeInstanceOf(UniqueCopiesUndetermined);
    });

    it('answers normally when there are no worktrees at all', async () => {
        // The other direction: a repository that never isolated has nothing to lose, and that must stay a plain empty
        // answer rather than an error — otherwise every archive on a clean change would refuse.
        const primary = repo('none');
        expect(await uniqueCopies({ root: primary })).toEqual([]);
    });

    it('raises when a worktree record directory cannot be read, not only when .kata/worktrees cannot', async () => {
        // **The other source of the same question.** The distinction was pinned for the worktrees directory and not for a
        // record directory: `filesUnder` swallowed every error, so a worktree whose task directory was mode 000 answered `[]`
        // — "nothing would be lost" about records nobody could read (measured by an independent review). Both sources raise.
        const primary = repo('records-unreadable');
        const worktree = join(primary, '.kata', 'worktrees', 'held');
        mkdirSync(join(worktree, '.kata', 'tasks', 'held'), { recursive: true });
        writeFileSync(join(worktree, '.kata', 'tasks', 'held', 'judge.json'), '{}\n');
        chmodSync(join(worktree, '.kata', 'tasks', 'held'), 0o000);
        try {
            await expect(uniqueCopies({ root: primary })).rejects.toBeInstanceOf(UniqueCopiesUndetermined);
        } finally {
            chmodSync(join(worktree, '.kata', 'tasks', 'held'), 0o755);
        }
    });

    it('answers "could not determine" from the ownership predicate, not "no owner"', async () => {
        // **The fold AC-4 refuses, one surface further.** The predicate asked the content rule and caught everything, so an
        // unreadable task directory answered "no checkout holds this task" — the answer `recordsRoot` writes through (measured
        // by an independent review). The failure travels now: a candidate that could not be read is not a candidate that holds
        // nothing, and when no candidate does hold the task, the answer is that it could not be determined.
        const primary = repo('owner-undetermined');
        const worktree = join(primary, '.kata', 'worktrees', 'held');
        const taskDir = join(worktree, '.kata', 'tasks', 'held');
        mkdirSync(taskDir, { recursive: true });
        writeFileSync(join(taskDir, 'judge.json'), '{}\n');
        chmodSync(taskDir, 0o000);
        try {
            const { recordOwner } = await import('../../src/core/layout.js');
            expect(() => recordOwner({ root: join(worktree, 'src'), taskId: 'held' })).toThrow(/cannot be read/iu);
        } finally {
            chmodSync(taskDir, 0o755);
        }
    });

    it('hands the reason to the archive, which removes nothing and reports it', async () => {
        // **"Could not answer" must reach the caller, not become a silent skip.** `archiveRemovalTargets` returned `[]` in
        // this state while its docstring claimed the archive kept every candidate, so the archive's result could not
        // distinguish "there was no worktree" from "the enumeration could not answer" — the distinction AC-8 exists to keep
        // (measured by an independent review).
        const primary = repo('archive-undetermined');
        const worktree = join(primary, '.kata', 'worktrees', 'held');
        mkdirSync(join(worktree, '.kata', 'tasks', 'held'), { recursive: true });
        writeFileSync(join(worktree, '.kata', 'tasks', 'held', 'judge.json'), '{}\n');
        chmodSync(join(worktree, '.kata', 'tasks', 'held'), 0o000);
        try {
            const { archiveRemovalOutcome } = await import('../../src/workflow/orchestrator.js');
            const outcome = await archiveRemovalOutcome(primary, 'held');

            expect(outcome.targets).toEqual([]);
            expect(outcome.undetermined).toMatch(/could not be determined/u);
        } finally {
            chmodSync(join(worktree, '.kata', 'tasks', 'held'), 0o755);
        }
    });

    it('names what it could not determine', async () => {
        const primary = repo('named');
        const worktrees = join(primary, '.kata', 'worktrees');
        mkdirSync(worktrees, { recursive: true });
        chmodSync(worktrees, 0o000);

        await expect(uniqueCopies({ root: primary })).rejects.toThrow(/could not be determined/u);
    });
});
