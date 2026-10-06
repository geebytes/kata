import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { evidenceDir, recordOwner, recordsRoot, wikiDir, wikiRecordPath } from '../../src/core/layout.js';

/**
 * AC-1 — one function answers which checkout owns a record and which task it belongs to.
 *
 * The measured defect: five places each derived the answer by their own shape, and they disagreed.
 *
 *   recordsRoot           walked ancestors for `.kata/tasks/<id>/current-state.json`
 *   worktreeOnlyRecords   scanned `.kata/worktrees/<dirname>` and read the task off the directory name
 *   removeWorktreeSafely  matched the task id the *caller* supplied
 *   worktreeOwner         took `listWorktrees().tasks[0]`
 *   evidenceDir           tested `isUnderLinkedWorktrees(path)`
 *
 * The consequence was not theoretical: `archive` deleted another task's only record because the guard asked a
 * different question from the detector. A property that five call sites re-derive is not held by any of them, so
 * this criterion asserts the answers rather than the call sites — a rewrite that routes them elsewhere but keeps
 * the answers passes, which is what "one derivation" is supposed to mean.
 */
const roots: string[] = [];

function repo(name: string): string {
    const root = mkdtempSync(join(tmpdir(), `kata-ownership-${name}-`));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), '{ "name": "owned", "private": true }\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    return root;
}

function seedTask(root: string, taskId: string): void {
    mkdirSync(join(root, '.kata', 'tasks', taskId), { recursive: true });
    writeFileSync(
        join(root, '.kata', 'tasks', taskId, 'current-state.json'),
        `${JSON.stringify({ taskId, phase: 'implement' })}\n`,
    );
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('record ownership has one answer', () => {
    it('names the owning checkout from inside a linked worktree', () => {
        const primary = repo('primary');
        seedTask(primary, 'a-task');
        const worktree = join(primary, '.kata', 'worktrees', 'a-task');
        mkdirSync(join(worktree, 'src'), { recursive: true });

        for (const from of [primary, worktree, join(worktree, 'src')]) {
            const owner = recordOwner({ root: from, taskId: 'a-task' });
            expect(owner.ownerRoot, `asked from ${from}`).toBe(primary);
        }
    });

    it('reports the worktree a path sits in, and the task that path carries', () => {
        const primary = repo('worktree-shape');
        seedTask(primary, 'held');
        const worktree = join(primary, '.kata', 'worktrees', 'dir-name-says-nothing');
        // The directory name is deliberately not the task id: `worktree create --path` produces this shape.
        mkdirSync(join(worktree, '.kata', 'tasks', 'held'), { recursive: true });

        const owner = recordOwner({ root: worktree, path: join(worktree, '.kata', 'tasks', 'held') });
        expect(owner.worktreeRoot).toBe(worktree);
        expect(owner.taskId, 'the task comes from the record directory, not the worktree name').toBe('held');
        expect(owner.ownerRoot).toBe(primary);
    });

    it('the evidence store, recordsRoot and the ownership answer agree on one path', () => {
        // **The assertion the defect fails.** These were three derivations; on a worktree whose name is not the task
        // id, `evidenceDir` and `recordsRoot` used to answer for different checkouts.
        const primary = repo('agree');
        seedTask(primary, 'held');
        const worktree = join(primary, '.kata', 'worktrees', 'unrelated-name');
        mkdirSync(join(worktree, '.kata', 'tasks', 'held'), { recursive: true });

        const owner = recordOwner({ root: worktree, taskId: 'held' });
        expect(owner.ownerRoot).toBeDefined();
        expect(evidenceDir(worktree)).toBe(join(owner.ownerRoot!, '.kata', 'evidence'));
        expect(recordsRoot(worktree, 'held')).toBe(owner.ownerRoot!);
        // **The Wiki store is the same question, and it was the last surface still derived per-caller.** Measured on a
        // task sealed under `isolated_worktree`: `wiki register` wrote the candidate under the primary checkout while
        // `verify --change` read the worktree's own `.kata/wiki`, which does not exist — so the closure gate answered
        // `candidate_missing` for a candidate that exists.
        expect(wikiDir(worktree)).toBe(join(owner.ownerRoot!, '.kata', 'wiki'));
        expect(wikiRecordPath(worktree, 'a-record')).toBe(join(owner.ownerRoot!, '.kata', 'wiki', 'a-record.json'));
        // And the worktree keeps no copy of its own: a second store would be a second answer, under a directory the
        // archive deletes.
        expect(wikiDir(worktree).startsWith(worktree)).toBe(false);
    });

    it('says no owner rather than inventing one when the task is nowhere', () => {
        // The previous shapes returned the caller's directory when nothing held the task, which made "unknown" read as
        // "here" — and let a command run inside a worktree write records into the worktree.
        const primary = repo('absent');
        const owner = recordOwner({ root: primary, taskId: 'never-created' });
        expect(owner.ownerRoot, 'an absent task has no owner, and the answer says so').toBeUndefined();
    });
});
