import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { recordOwner, worktreeOnlyRecords } from '../../src/core/layout.js';

/**
 * AC-4 — ownership is not granted by the presence of a file.
 *
 * Two measured shapes, both from the readings:
 *
 *   • `recordsRoot` keyed on `.kata/tasks/<id>/current-state.json`, so writing that one file into an unrelated nested
 *     checkout moved ownership — and `taskDir` began writing the task's records there.
 *   • a worktree created with `--path` lives wherever the operator put it, so every test of the form
 *     `isUnderLinkedWorktrees(path)` missed it: the detector reported `[]` for a worktree holding the only copy of a
 *     record, and the removal guard had nothing to refuse on.
 *
 * The criterion is the answer, not the key: a directory that holds no task records is not an owner, and a worktree
 * outside `.kata/worktrees` is recognised like any other.
 */
const roots: string[] = [];

function repo(name: string): string {
    const root = mkdtempSync(join(tmpdir(), `kata-ownership-file-${name}-`));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), '{ "name": "owned", "private": true }\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ownership is not granted by a file', () => {
    it('a directory holding only a marker file is not an owner', () => {
        const primary = repo('marker');
        mkdirSync(join(primary, '.kata', 'tasks', 'held'), { recursive: true });
        writeFileSync(join(primary, '.kata', 'tasks', 'held', 'judge.json'), '{}\n');

        // A bare marker in an unrelated nested checkout: the old key treated it as ownership.
        const intruder = join(primary, 'vendor', 'copy');
        mkdirSync(join(intruder, '.kata', 'tasks'), { recursive: true });
        writeFileSync(join(intruder, '.kata', 'tasks', 'held.json'), '{}\n');

        const owner = recordOwner({ root: join(intruder, 'src'), taskId: 'held' });
        expect(owner.ownerRoot, 'a stray file grants nothing').toBe(primary);
    });

    it('a task directory with no state file is still an owner', () => {
        // The other direction, and the one the old key got wrong: the task's directory is the fact.
        const primary = repo('directory');
        mkdirSync(join(primary, '.kata', 'tasks', 'held'), { recursive: true });
        writeFileSync(join(primary, '.kata', 'tasks', 'held', 'verdicts.json'), '{}\n');

        const owner = recordOwner({ root: join(primary, 'src'), taskId: 'held' });
        expect(owner.ownerRoot).toBe(primary);
    });

    it('recognises a worktree that lives outside .kata/worktrees', () => {
        // What `worktree create --path <somewhere>` produces, and what every path-shape test missed.
        //
        // **The holder must hold something.** This fixture used to create empty task directories and assert that an owner
        // was found — which is the very predicate the record model replaces, so the case asserted the old behaviour. A
        // checkout is a holder when its task directory carries a record.
        const primary = repo('outside');
        mkdirSync(join(primary, '.kata', 'tasks', 'held'), { recursive: true });
        writeFileSync(join(primary, '.kata', 'tasks', 'held', 'judge.json'), '{}\n');
        const outside = join(primary, 'elsewhere', 'a-checkout');
        mkdirSync(join(outside, '.kata', 'tasks', 'held'), { recursive: true });
        writeFileSync(join(outside, '.kata', 'tasks', 'held', 'verdicts.json'), '{}\n');

        const owner = recordOwner({ root: outside, path: join(outside, '.kata', 'tasks', 'held') });
        expect(owner.taskId).toBe('held');
        // It holds the task itself, so it is the nearest holder from that path — the point of the case is that the shape
        // is recognised at all rather than reported as nothing.
        expect(owner.ownerRoot).toBe(outside);
    });

    it('the detector sees a worktree that lives outside .kata/worktrees', async () => {
        // **The shape this change's own challenge caught.** `worktreeOnlyRecords` scanned `.kata/worktrees/` only, so a
        // real linked checkout created with `worktree create --path` reported `[]` while `recordOwner` recognised it —
        // the ownership function and one of its consumers disagreeing, which is the defect this change exists to remove,
        // reproduced inside it. Both sources are now unioned: `git worktree list` (the only one that sees a `--path`
        // checkout) and the directory this repository creates them in.
        const primary = repo('outside-detector');
        writeFileSync(join(primary, '.gitignore'), '.kata/\n');
        execFileSync('git', ['add', '-A'], { cwd: primary });
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: primary });

        const outside = join(primary, 'elsewhere', 'checkout');
        mkdirSync(join(primary, 'elsewhere'), { recursive: true });
        execFileSync('git', ['worktree', 'add', '-q', '-b', 'wt-branch', outside], { cwd: primary });
        mkdirSync(join(outside, '.kata', 'tasks', 'held'), { recursive: true });
        writeFileSync(join(outside, '.kata', 'tasks', 'held', 'judge.json'), '{}\n');

        const report = await worktreeOnlyRecords(primary);
        expect(report.some((entry) => entry.worktree.includes('elsewhere')), JSON.stringify(report)).toBe(true);
    });

    it('an empty directory is not an owner', () => {
        const primary = repo('empty');
        mkdirSync(join(primary, '.kata', 'tasks'), { recursive: true });

        const owner = recordOwner({ root: primary, taskId: 'never-created' });
        expect(owner.ownerRoot, 'a task directory that does not exist is not ownership').toBeUndefined();
    });
});
