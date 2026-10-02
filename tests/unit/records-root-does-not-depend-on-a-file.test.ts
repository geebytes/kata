import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordsRoot, resolveWorkspaceRootForTask } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { readCurrentState, transition } from '../../src/core/state.js';

/**
 * AC-1 — the record root is decided by where the task lives, never by which files exist on disk.
 *
 * The measured defect: with a linked worktree nested inside its primary checkout, the two resolvers disagree about the
 * same task.
 *
 *     recordsRoot(worktree)              -> the primary checkout      (correct: it already skips `.kata/worktrees/`)
 *     resolveWorkspaceRootForTask(worktree) -> the worktree           (the nearest `current-state.json` wins)
 *
 * `resolveWorkspaceRootForTask` decides by `exists(<candidate>/.kata/tasks/<id>/current-state.json)`, so ownership is a
 * function of file existence. That is the shape this criterion has to make red: the answer must not move because a file
 * appeared in, or disappeared from, a directory that is not the task's owner.
 *
 * The probe that established the shape is reproduced here rather than paraphrased, because a paraphrase is what made the
 * first version of this file pass against the defect it was written for.
 */
let root: string;
const taskId = 'a-task';

function seedTask(dir: string, phase: string): void {
    mkdirSync(join(dir, '.kata', 'tasks', taskId), { recursive: true });
    writeFileSync(join(dir, '.kata', 'tasks', taskId, 'current-state.json'), JSON.stringify({ taskId, phase }));
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kata-records-root-'));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe('the record root does not depend on which files exist', () => {
    it('a nested worktree holding the marker does not become the task owner', () => {
        seedTask(root, 'implement');
        const worktree = join(root, '.kata', 'worktrees', 'iso');
        seedTask(worktree, 'review');

        // The task's dir lives in the primary checkout; the worktree's copy is a second answer to one question, which is
        // exactly what the single-owner rule exists to prevent.
        expect(recordsRoot(root, taskId)).toBe(root);
        expect(recordsRoot(worktree, taskId)).toBe(root);
    });

    it('every site that decides ownership asks the same question', () => {
        // **Three places derived "who owns this task" and one kept the old key.** `recordsRoot` was moved onto the task
        // directory while `findDescendantTaskRoots` still asked for `current-state.json`. Honest note on what this case
        // can and cannot show: that branch is **not currently reachable from here**, because `resolveWorkspaceRootForTask`
        // consults `recordsRoot` first and `recordsRoot` already finds a self-contained task — so a mutation of the
        // descendant key does *not* redden this file. What the case pins is the answer, not the branch: a checkout whose
        // task directory exists without `current-state.json` is an owner for both resolvers, so whichever route reaches it
        // agrees. The unreachable site is named in the design doc as a residual, rather than presented as covered.
        const sibling = mkdtempSync(join(tmpdir(), 'kata-records-sibling-'));
        writeFileSync(join(sibling, 'package.json'), '{ "name": "sibling", "private": true }\n');
        mkdirSync(join(sibling, '.kata', 'tasks', taskId), { recursive: true });
        // **Deliberately no `current-state.json`.** That is what tells the two candidate keys apart: a site asking for
        // the file does not see this sibling at all, while one asking for the directory does. Without this the case
        // passes under both, which is how the descendant scan kept the old key through the previous fix.
        writeFileSync(join(sibling, '.kata', 'tasks', taskId, 'judge.json'), '{}\n');

        // No ancestor holds the task, so the descendant search is the only route to it.
        expect(recordsRoot(join(sibling, 'src'), taskId)).toBe(sibling);
        expect(resolveWorkspaceRootForTask(taskId, join(sibling, 'src'))).toBe(sibling);
        rmSync(sibling, { recursive: true, force: true });
    });

    it('a task directory that holds no current-state.json is still an owner', () => {
        // **The key used to be a file, not the directory.** Ownership asked for `.kata/tasks/<id>/current-state.json`,
        // so a checkout whose task directory existed but had not yet been given that file was not recognised as the
        // owner — and the answer moved the moment the file appeared. Ownership is a fact about the task directory, so a
        // directory is an owner whether or not a particular file inside it has been written yet.
        const bare = mkdtempSync(join(tmpdir(), 'kata-records-bare-'));
        writeFileSync(join(bare, 'package.json'), '{ "name": "bare", "private": true }\n');
        mkdirSync(join(bare, '.kata', 'tasks', taskId), { recursive: true });
        writeFileSync(join(bare, '.kata', 'tasks', taskId, 'judge.json'), '{}\n');

        expect(recordsRoot(join(bare, 'src'), taskId)).toBe(bare);
        expect(resolveWorkspaceRootForTask(taskId, join(bare, 'src'))).toBe(bare);
        rmSync(bare, { recursive: true, force: true });
    });

    it('the two resolvers agree about the same task from the same directory', () => {
        seedTask(root, 'implement');
        const worktree = join(root, '.kata', 'worktrees', 'iso');
        seedTask(worktree, 'review');

        const records = recordsRoot(worktree, taskId);
        const task = resolveWorkspaceRootForTask(taskId, worktree);
        // Disagreeing here is the defect: one question, two answers, and which you get depends on which function the
        // caller happened to import.
        expect(task).toBe(records);
    });

    it('ownership does not move when the marker file is removed from a non-owner', () => {
        seedTask(root, 'implement');
        const worktree = join(root, '.kata', 'worktrees', 'iso');
        seedTask(worktree, 'review');

        const before = resolveWorkspaceRootForTask(taskId, worktree);
        rmSync(join(worktree, '.kata', 'tasks', taskId, 'current-state.json'));
        const after = resolveWorkspaceRootForTask(taskId, worktree);

        expect(after).toBe(before);
        expect(after).toBe(root);
    });

    it('a caller standing below the owner resolves to the owner without a file of its own', () => {
        seedTask(root, 'implement');
        const nested = join(root, 'src', 'deep', 'nested');
        mkdirSync(nested, { recursive: true });

        expect(recordsRoot(nested, taskId)).toBe(root);
        expect(resolveWorkspaceRootForTask(taskId, nested)).toBe(root);
    });

    it('a write from inside the worktree lands at the owner, not in the worktree copy', async () => {
        // The read-side answer being right is not enough: the owner rule has to hold on the write path too, or a command
        // run inside the worktree recreates the second copy the rule exists to prevent. This case came from the file named
        // for the withdrawn AC-1; it is folded in here because one criterion must have one selector, and a second file
        // asserting the same criterion is how a change ends up with two answers to one question — the defect it fixes.
        let createdTask: Promise<unknown>;
        const primary = mkdtempSync(join(tmpdir(), 'kata-records-write-'));
        const taskId2 = 'owner-task';
        writeFileSync(join(primary, 'package.json'), '{ "name": "fixture", "private": true }\n');
        // The record is created by the engine's own writer, because a hand-written state file that does not match the schema
        // is indistinguishable from "no state" at the reader — the same confusion this change keeps removing.
        createdTask = createTask({
            root: primary,
            id: taskId2,
            title: 'Owner',
            acceptance: [{ id: 'AC-1', statement: 'x' }],
            ownedPaths: ['src/a.ts'],
        });

        const linked = join(primary, '.kata', 'worktrees', taskId2);
        const linkedTaskDir = join(linked, '.kata', 'tasks', taskId2);
        mkdirSync(linkedTaskDir, { recursive: true });
        writeFileSync(
            join(linkedTaskDir, 'current-state.json'),
            `${JSON.stringify({ taskId: taskId2, phase: 'hardVerify', updatedAt: '2026-10-01T00:00:00.000Z' }, null, 2)}\n`,
        );

        await createdTask;
        expect(recordsRoot(linked, taskId2)).toBe(primary);

        // A transition run from the worktree writes to the owner, because `taskDir` routes every record path through
        // `recordsRoot`. Asserting the write path matters: a read-side answer that is right while the write side still
        // lands in the worktree recreates the second copy the rule exists to prevent.
        await transition(taskId2, 'plan', { id: 'implementer', role: 'implementer' }, { root: linked });

        const linkedState = JSON.parse(readFileSync(join(linkedTaskDir, 'current-state.json'), 'utf8')) as { phase: string };
        expect(linkedState.phase, 'the worktree copy must not be the one that moved').toBe('hardVerify');
        expect((await readCurrentState(primary, taskId2)).phase).toBe('plan');

        rmSync(primary, { recursive: true, force: true });
    });
});
