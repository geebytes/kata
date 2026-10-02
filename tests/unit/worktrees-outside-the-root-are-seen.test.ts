import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { uniqueCopies } from '../../src/core/layout.js';

/**
 * AC-2 — a linked worktree outside the repository root is seen.
 *
 * The measured defect (reading 1, F5, blocking): the enumeration kept candidates with
 * `relativePath !== '' && !relativePath.startsWith('..')`, which drops **every** checkout outside the root — and the
 * `.kata/worktrees/` directory cannot cover them either, because `worktree create --path /elsewhere` puts the checkout
 * wherever the operator asked. Result: the detector returned `[]` for a worktree holding the only copy, the guard had
 * nothing to refuse on, and archive removed it.
 *
 * `elsewhere/checkout` (inside the root) was the shape the previous repair covered. The shape that proves the criterion
 * is one the old predicate could not represent at all: a sibling of the repository.
 */
const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repo(name: string): string {
    const root = mkdtempSync(join(tmpdir(), `kata-uc-outside-${name}-`));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), '{ "name": "uc", "private": true }\n');
    writeFileSync(join(root, '.gitignore'), '.kata/\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: root });
    return root;
}

describe('worktrees outside the root are seen', () => {
    it('reports a worktree that is a sibling of the repository', async () => {
        const primary = repo('sibling');
        // **Outside the repository root entirely** — the shape `!startsWith('..')` discarded.
        const outside = `${primary}-linked`;
        roots.push(outside);
        execFileSync('git', ['worktree', 'add', '-q', '-b', 'outside-branch', outside], { cwd: primary });
        mkdirSync(join(outside, '.kata', 'tasks', 'held'), { recursive: true });
        writeFileSync(join(outside, '.kata', 'tasks', 'held', 'judge.json'), '{}\n');

        const copies = await uniqueCopies({ root: primary });
        const forHeld = copies.filter((copy) => copy.taskId === 'held');
        expect(forHeld, JSON.stringify(copies)).toHaveLength(1);
        expect(forHeld[0]!.path).toBe('tasks/judge.json');
        // The reported location is where the copy actually is, and it is not inside the root.
        expect(forHeld[0]!.worktreeRoot).toBe(outside);
    });

    it('does not report a worktree whose copy the owner also has', async () => {
        const primary = repo('both-have');
        const outside = `${primary}-linked`;
        roots.push(outside);
        execFileSync('git', ['worktree', 'add', '-q', '-b', 'both-branch', outside], { cwd: primary });
        for (const root of [primary, outside]) {
            mkdirSync(join(root, '.kata', 'tasks', 'held'), { recursive: true });
            writeFileSync(join(root, '.kata', 'tasks', 'held', 'judge.json'), '{}\n');
        }

        const copies = await uniqueCopies({ root: primary });
        expect(copies.filter((copy) => copy.taskId === 'held')).toHaveLength(0);
    });
});
