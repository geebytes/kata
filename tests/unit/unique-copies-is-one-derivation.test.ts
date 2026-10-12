import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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

    it('names the task context through the ownership rule, not through the caller root', async () => {
        // **A consumer the challenge found.** The handoff receipt's `diffHash` is computed over these paths, and they
        // were built as `.kata/tasks/<id>/…` joined onto whatever root the caller passed — so a receipt signed from a
        // worktree named the worktree's copy while every other reader named the owner's. Two names for one task's records
        // is the defect this line of work removes; here it made a receipt's identity depend on where it was signed.
        const primary = repo('context-paths');
        const worktree = join(primary, '.kata', 'worktrees', 'held');
        mkdirSync(join(primary, '.kata', 'tasks', 'held'), { recursive: true });
        writeFileSync(join(primary, '.kata', 'tasks', 'held', 'task.json'), '{}\n');
        mkdirSync(join(worktree, '.kata', 'tasks', 'held'), { recursive: true });
        writeFileSync(join(worktree, '.kata', 'tasks', 'held', 'task.json'), '{}\n');

        const { recordsRoot } = await import('../../src/core/layout.js');
        // From inside the worktree, both readers must name the same place.
        expect(recordsRoot(worktree, 'held')).toBe(primary);
    });

    it('finds a task whose records exist only on the evidence surface, with no task directory at all', async () => {
        // **The two halves of one enumeration.** The task list came from `.kata/tasks/<id>` directories while the record
        // surfaces are enumerated from content (the task directory plus the evidence store's `<taskId>-` prefix), so a task
        // with records only in the evidence store was invisible to the unscoped form while the scoped form reported its
        // files (measured by an independent review). Both forms must answer the same question.
        const primary = repo('evidence-only');
        const worktree = join(primary, '.kata', 'worktrees', 'held');
        mkdirSync(join(worktree, '.kata', 'evidence'), { recursive: true });
        // A realistic record: the evidence schema requires `taskId`, and **that field is how the task is known** — the id is
        // never split out of the file name (a hyphenated id truncated at its first hyphen is what an independent review
        // measured, and hyphenated ids are the norm here).
        writeFileSync(join(worktree, '.kata', 'evidence', 'held-AC-1.json'), `${JSON.stringify({ taskId: 'held', id: 'AC-1-E1' })}\n`);

        const unscoped = (await uniqueCopies({ root: primary })).filter((copy) => copy.taskId === 'held');
        const scoped = await uniqueCopies({ root: primary, taskId: 'held' });

        expect(scoped.map((copy) => copy.path)).toEqual(['evidence/held-AC-1.json']);
        expect(unscoped.map((copy) => copy.path)).toEqual(scoped.map((copy) => copy.path));
    });

    it('answers a hyphenated task id whole, and does not report one file under two tasks', async () => {
        // **The truncation the content-derived id replaces.** Splitting the evidence file name at its first hyphen answered
        // `some-task-AC-1.json` as the task `some` (which does not exist) and reported one file under two ids when the task
        // also had a directory — measured by an independent review, and every id in this repository is hyphenated.
        const primary = repo('hyphenated');
        const worktree = join(primary, '.kata', 'worktrees', 'held');
        mkdirSync(join(worktree, '.kata', 'tasks', 'some-task'), { recursive: true });
        mkdirSync(join(worktree, '.kata', 'evidence'), { recursive: true });
        writeFileSync(join(worktree, '.kata', 'tasks', 'some-task', 'judge.json'), '{}\n');
        writeFileSync(join(worktree, '.kata', 'evidence', 'some-task-AC-1.json'), `${JSON.stringify({ taskId: 'some-task', id: 'AC-1-E1' })}\n`);

        const copies = await uniqueCopies({ root: primary });
        const taskIds = [...new Set(copies.map((copy) => copy.taskId))].sort();

        expect(taskIds).toEqual(['some-task']);
        expect(copies.map((copy) => copy.path).sort()).toEqual(['evidence/some-task-AC-1.json', 'tasks/judge.json']);
    });

    it('answers ownership with the same rule the enumeration uses, including a record under a subdirectory', async () => {
        // **Two answers to "does this checkout hold records of this task".** The predicate asked for a direct file entry
        // while the enumeration asked across both surfaces recursively, so a worktree whose task directory held
        // `handoffs/x.json` was named by the model as holding the only copy while `recordOwner` said no checkout held it
        // (measured by an independent review). The predicate asks the one rule now, so depth is a record here too.
        const primary = repo('ownership-depth');
        const worktree = join(primary, '.kata', 'worktrees', 'held');
        mkdirSync(join(worktree, '.kata', 'tasks', 'held', 'handoffs'), { recursive: true });
        writeFileSync(join(worktree, '.kata', 'tasks', 'held', 'handoffs', 'x.json'), '{}\n');

        const { recordOwner } = await import('../../src/core/layout.js');
        const copies = await uniqueCopies({ root: primary });

        expect(copies.map((copy) => copy.path)).toEqual(['tasks/handoffs/x.json']);
        expect(recordOwner({ root: join(worktree, 'src'), taskId: 'held' }).ownerRoot).toBe(worktree);
    });

    it('asks the model for the guard, so a worktree outside the root is not removed with its only copy', async () => {
        // **The removal guard is a consumer of the answer, and it asked a second derivation.** `worktreeOnlyRecords` had
        // its own enumeration and comparison; on an outside-root worktree holding the only copy of a record it answered
        // `[]` while the model named the file, so the guard let the removal through and the only copy was deleted
        // (measured by an independent review, in the data-loss direction). This drives the guard, not the report.
        const primary = repo('guard');
        // A **real** linked checkout, outside the root: that is the shape `worktree create --path` produces, and the shape
        // the model keeps (a directory that is not a linked checkout is not a holder at all).
        const outside = join(dirname(primary), `${basename(primary)}-outside`);
        roots.push(outside);
        execFileSync('git', ['worktree', 'add', '-q', outside, '-b', 'outside-branch'], { cwd: primary });
        mkdirSync(join(outside, '.kata', 'tasks', 'held'), { recursive: true });
        writeFileSync(join(outside, '.kata', 'tasks', 'held', 'judge.json'), '{}\n');

        const { removeWorktreeSafely } = await import('../../src/workflow/worktree.js');
        const removal = await removeWorktreeSafely({ root: primary, path: outside, taskId: 'held' });

        expect(removal.refusedBecause).toBe('worktree-only-records');
        expect(removal.removed).toBe(false);
        // The flat list keeps its contract, the attribution is additive, and the remedy names the task's own road
        // (round 2's F6: the refusal reported the first task's remedy with a flat list, so a two-task worktree named one
        // task's road and the reader could not tell which file belonged to which task).
        expect(removal.worktreeOnlyRecords).toContain('tasks/judge.json');
        expect(removal.worktreeOnlyRecordsByTask).toEqual([{ taskId: 'held', files: ['tasks/judge.json'] }]);
        expect(removal.remedy).toContain('worktree recover --change held');
    });

    it('names every task the worktree holds, not only the first, when it refuses', async () => {
        // **A refusal has to be readable back to the state.** A worktree holding unique records of two tasks reported one
        // task's remedy and a flat file list, so the operator could not tell which road belonged to which task (measured by an
        // independent review). Every task is named, and every file is attributed.
        const primary = repo('two-tasks');
        const outside = join(dirname(primary), `${basename(primary)}-two`);
        roots.push(outside);
        execFileSync('git', ['worktree', 'add', '-q', outside, '-b', 'two-branch'], { cwd: primary });
        for (const taskId of ['aaa', 'zzz']) {
            mkdirSync(join(outside, '.kata', 'tasks', taskId), { recursive: true });
            writeFileSync(join(outside, '.kata', 'tasks', taskId, 'judge.json'), '{}\n');
        }

        const { removeWorktreeSafely } = await import('../../src/workflow/worktree.js');
        const removal = await removeWorktreeSafely({ root: primary, path: outside, taskId: 'aaa' });

        expect(removal.refusedBecause).toBe('worktree-only-records');
        expect(removal.worktreeOnlyRecordsByTask).toEqual([
            { taskId: 'aaa', files: ['tasks/judge.json'] },
            { taskId: 'zzz', files: ['tasks/judge.json'] },
        ]);
        expect(removal.remedy).toContain('--change aaa');
        expect(removal.remedy).toContain('--change zzz');
    });

    it('names a remedy that runs in the state it prints in, when the enumeration cannot answer', async () => {
        // **A refusal whose road is closed.** The undetermined refusal named `kata-cli worktree list`, and in that very state
        // that command throws the same `RecordSourceUnreadable` (measured by an independent review). No kata command can
        // repair an unreadable directory, so the refusal says that and names the retry command instead.
        const primary = repo('guard-undetermined');
        const outside = join(dirname(primary), `${basename(primary)}-undet`);
        roots.push(outside);
        execFileSync('git', ['worktree', 'add', '-q', outside, '-b', 'undet-branch'], { cwd: primary });
        const taskDir = join(outside, '.kata', 'tasks', 'held');
        mkdirSync(taskDir, { recursive: true });
        writeFileSync(join(taskDir, 'judge.json'), '{}\n');
        chmodSync(taskDir, 0o000);
        try {
            const { removeWorktreeSafely } = await import('../../src/workflow/worktree.js');
            const removal = await removeWorktreeSafely({ root: primary, path: outside, taskId: 'held' });

            expect(removal.refusedBecause).toBe('worktree-only-records');
            expect(removal.remedy).not.toContain('worktree list');
            expect(removal.remedy).toContain('worktree remove');
            expect(removal.remedyDetail).toMatch(/no kata command can repair/iu);
        } finally {
            chmodSync(taskDir, 0o755);
        }
    });

    it('asks the content reader for the tasks a checkout holds, so a state file is not the test', async () => {
        // **The same question, one more surface.** The worktree listing answered "which tasks are here" by the existence of
        // `current-state.json`, and `worktreeOwner` fell back to the first directory name under `.kata/tasks` with no content
        // check — so a worktree holding review records and no state file read as holding nothing, and a stray directory made
        // it report a task it does not hold (both measured by an independent review).
        const primary = repo('listing');
        const worktree = join(primary, '.kata', 'worktrees', 'held');
        mkdirSync(join(worktree, '.kata', 'tasks', 'held'), { recursive: true });
        writeFileSync(join(worktree, '.kata', 'tasks', 'held', 'judge.json'), '{}\n');
        mkdirSync(join(worktree, '.kata', 'tasks', 'stray'), { recursive: true });

        const { tasksWithRecords } = await import('../../src/core/layout.js');
        expect(await tasksWithRecords(worktree)).toEqual(['held']);
    });

    it('an absent task yields an empty answer, and a task with nothing yields the same', async () => {
        // Both are "there is nothing to lose", and they are different from "the source could not be read" (AC-4).
        const primary = repo('absent');
        mkdirSync(join(primary, '.kata', 'tasks', 'empty'), { recursive: true });

        expect(await uniqueCopies({ root: primary, taskId: 'never-created' })).toEqual([]);
        expect(await uniqueCopies({ root: primary, taskId: 'empty' })).toEqual([]);
    });
});
