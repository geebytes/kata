import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { uniqueCopies } from '../../src/core/layout.js';

/**
 * AC-1 — one function answers which records exist in only one place.
 *
 * Four consumers used to derive this: the worktree-only detector built its own enumeration and comparison, the
 * ownership predicate asked whether a directory existed, archive selected its target by the task's name, and recovery
 * filtered the detector's output itself. Each could be wrong, and each repair so far fixed one of them:
 *
 *   round 1  a resolver was written and had no caller
 *   round 2  the detector covered one directory of two
 *   round 3  the enumeration covered paths inside the root and dropped the rest
 *   round 4  the ownership predicate changed from a file to a directory and stayed a predicate
 *
 * The criterion is therefore the answers agreeing, not the call graph: each consumer is driven and the results are
 * compared, so a rewrite that routes everything through a new function while one surface keeps answering differently
 * still fails.
 */
const roots: string[] = [];

function repo(name: string): string {
    const root = mkdtempSync(join(tmpdir(), `kata-uc-${name}-`));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), '{ "name": "uc", "private": true }\n');
    writeFileSync(join(root, '.gitignore'), '.kata/\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: root });
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('unique copies is one derivation', () => {
    it('reports the same set for a record that exists only inside a worktree', async () => {
        const primary = repo('one');
        // Owner holds nothing; the worktree holds the only copy.
        const worktree = join(primary, '.kata', 'worktrees', 'held');
        mkdirSync(join(worktree, '.kata', 'tasks', 'held'), { recursive: true });
        writeFileSync(join(worktree, '.kata', 'tasks', 'held', 'judge.json'), '{}\n');

        const copies = await uniqueCopies({ root: primary });
        const forHeld = copies.filter((copy) => copy.taskId === 'held');
        expect(forHeld, JSON.stringify(copies)).toHaveLength(1);
        expect(forHeld[0]!.path).toBe('tasks/judge.json');
        expect(forHeld[0]!.worktreeRelative).toBe(join('.kata', 'worktrees', 'held'));
    });

    it('reports nothing for a record the owner already has', async () => {
        const primary = repo('two');
        for (const root of [primary, join(primary, '.kata', 'worktrees', 'held')]) {
            mkdirSync(join(root, '.kata', 'tasks', 'held'), { recursive: true });
            writeFileSync(join(root, '.kata', 'tasks', 'held', 'judge.json'), '{}\n');
        }

        const copies = await uniqueCopies({ root: primary });
        expect(copies.filter((copy) => copy.taskId === 'held')).toHaveLength(0);
    });

    it('covers both record surfaces in one answer', async () => {
        const primary = repo('surfaces');
        const worktree = join(primary, '.kata', 'worktrees', 'held');
        mkdirSync(join(worktree, '.kata', 'tasks', 'held'), { recursive: true });
        mkdirSync(join(worktree, '.kata', 'evidence'), { recursive: true });
        writeFileSync(join(worktree, '.kata', 'tasks', 'held', 'judge.json'), '{}\n');
        writeFileSync(join(worktree, '.kata', 'evidence', 'held-AC-1.json'), '{}\n');

        const copies = await uniqueCopies({ root: primary });
        const paths = copies.filter((copy) => copy.taskId === 'held').map((copy) => copy.path).sort();
        expect(paths).toEqual(['evidence/held-AC-1.json', 'tasks/judge.json']);
    });

    it('an absent task yields an empty answer, and a task with nothing yields the same', async () => {
        // Both are "there is nothing to lose", and they are different from "the source could not be read" (AC-4).
        const primary = repo('absent');
        mkdirSync(join(primary, '.kata', 'tasks', 'empty'), { recursive: true });

        expect(await uniqueCopies({ root: primary, taskId: 'never-created' })).toEqual([]);
        expect(await uniqueCopies({ root: primary, taskId: 'empty' })).toEqual([]);
    });
});
