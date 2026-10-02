import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uniqueCopies } from '../../src/core/layout.js';
import { recoverWorktreeRecords } from '../../src/workflow/worktree.js';

/**
 * AC-5 — a record held by more than one worktree is counted once, and recovery does not silently overwrite.
 *
 * The measured defect (reading 1, F7): the detector compared each worktree against the owner independently, so a task
 * held by two worktrees reported `common.json` **twice** — the same loss named twice, and a recovery that moved it from
 * the first worktree and then found it already present in the owner reported the second as `kept` while the owner's copy
 * was the first one's content. The reading's output:
 *
 *   report = [{shared, wt-a, [common.json, only-a.json]}, {shared, wt-b, [common.json, only-b.json]}]
 *   files counted twice? true
 *   owner common.json content = {"from":"a"}     <- the first move won, silently
 *
 * Uniqueness is therefore a property of the whole set of holders: a record is unique only when exactly one holds it.
 */
const roots: string[] = [];

function repo(name: string): string {
    const root = mkdtempSync(join(tmpdir(), `kata-uc-twice-${name}-`));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), '{ "name": "uc", "private": true }\n');
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('a record held twice is counted once', () => {
    it('names a shared record neither worktree’s unique loss', async () => {
        const primary = repo('shared');
        for (const name of ['wt-a', 'wt-b']) {
            const worktree = join(primary, '.kata', 'worktrees', name);
            mkdirSync(join(worktree, '.kata', 'tasks', 'shared'), { recursive: true });
            writeFileSync(join(worktree, '.kata', 'tasks', 'shared', 'common.json'), `{"from":"${name}"}\n`);
        }
        // Only `wt-a` has a file of its own.
        writeFileSync(join(primary, '.kata', 'worktrees', 'wt-a', '.kata', 'tasks', 'shared', 'only-a.json'), '{}\n');

        const copies = await uniqueCopies({ root: primary });
        const paths = copies.filter((copy) => copy.taskId === 'shared').map((copy) => copy.path).sort();
        expect(paths, JSON.stringify(copies)).toEqual(['tasks/only-a.json']);
    });

    it('a record held by one worktree is reported once, not once per holder', async () => {
        const primary = repo('single');
        const worktree = join(primary, '.kata', 'worktrees', 'only');
        mkdirSync(join(worktree, '.kata', 'tasks', 'held'), { recursive: true });
        writeFileSync(join(worktree, '.kata', 'tasks', 'held', 'judge.json'), '{}\n');

        const copies = await uniqueCopies({ root: primary });
        expect(copies.filter((copy) => copy.taskId === 'held')).toHaveLength(1);
    });

    it('recovery moves a worktree-only record and leaves a shared one alone', async () => {
        const primary = repo('recover');
        // Two worktrees hold `common-<n>.json`; only `wt-a` holds `only-a.json`.
        for (const name of ['wt-a', 'wt-b']) {
            const worktree = join(primary, '.kata', 'worktrees', name);
            mkdirSync(join(worktree, '.kata', 'tasks', 'shared'), { recursive: true });
            writeFileSync(join(worktree, '.kata', 'tasks', 'shared', `common-${name}.json`), `{"from":"${name}"}\n`);
        }

        const results = await recoverWorktreeRecords({ root: primary, taskId: 'shared' });
        // Every record here is unique to one worktree, so every one is moved — and none is left behind silently.
        const moved = results.flatMap((entry) => entry.moved).sort();
        expect(moved).toEqual(['tasks/common-wt-a.json', 'tasks/common-wt-b.json']);
        // What a shared record does *not* do: it is never named unique, so recovery is never asked to choose a winner.
        const shared = await uniqueCopies({ root: primary });
        expect(shared.filter((copy) => copy.taskId === 'shared')).toEqual([]);
    });

});
