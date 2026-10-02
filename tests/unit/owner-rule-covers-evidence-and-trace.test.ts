import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evidenceDir, initLayout, recordsRoot } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';

/**
 * **AC-5: the owner rule covers every record surface — evidence included.**
 *
 * Records were given one owner (`recordsRoot`, which skips `.kata/worktrees/`), but `evidenceDir(root)` still returned
 * `join(kataDir(root), 'evidence')` for whatever root the caller passed. Evidence is a governed record — it is what a
 * verification run proved, and it is named after the task that produced it — so it belongs to the same owner.
 *
 * The second half is the tracked set. `.gitignore` carries a whitelist that admits the trace; if the whitelist and the
 * owner rule disagree, a record can be owned by the primary checkout and still never leave the working tree, or be admitted
 * while living only under a worktree the archive deletes. The criterion is that the two agree, checked against git itself
 * rather than against a copy of the rules.
 */
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(): Promise<{ primary: string; linked: string }> {
    const primary = await mkdtemp(join(tmpdir(), 'kata-evidence-owner-'));
    roots.push(primary);
    await initLayout(primary);
    await createTask({
        root: primary,
        id: 'evidence-task',
        title: 'Evidence',
        acceptance: [{ id: 'AC-1', statement: 'x' }],
        ownedPaths: ['src/a.ts'],
    });
    const linked = join(primary, '.kata', 'worktrees', 'evidence-task');
    await mkdir(join(linked, '.kata', 'tasks', 'evidence-task'), { recursive: true });
    return { primary, linked };
}

describe('the owner rule covers evidence, and the tracked set agrees with it', () => {
    it('evidence written against a worktree root lands under the owning checkout', async () => {
        const { primary, linked } = await fixture();

        // The worktree is the *code* root; the record root is the primary checkout. Evidence must follow the record.
        expect(recordsRoot(linked, 'evidence-task')).toBe(primary);
        const fromWorktree = evidenceDir(linked);
        expect(fromWorktree).toBe(join(primary, '.kata', 'evidence'));
    });

    it('an evidence file is reachable from the owner whatever root wrote it', async () => {
        const { primary, linked } = await fixture();
        const name = 'evidence-task-AC-1-test-tests-unit-example.test.ts.json';
        const written = join(evidenceDir(linked), name);
        await mkdir(evidenceDir(linked), { recursive: true });
        await writeFile(written, '{"ok":true}\n');

        // Read back through the primary checkout's own resolution: one file, one owner, no per-root copy.
        const viaOwner = join(evidenceDir(primary), name);
        expect(await readFile(viaOwner, 'utf8')).toContain('"ok":true');
        // And there is no second copy under the worktree's own `.kata/evidence`.
        expect(viaOwner.startsWith(linked)).toBe(false);
    });

    it('the .gitignore whitelist and the record files agree, measured against git itself', async () => {
        // The repository carries the whitelist; the check asks git what it would add, so the answer cannot drift from the
        // rules the way a hand-written list of expected names would.
        const { execFileSync } = await import('node:child_process');
        const repoRoot = '/data/work/ahaeureka/k2skills/kata';
        const listed = execFileSync('git', ['add', '-An', '.kata/'], { cwd: repoRoot, encoding: 'utf8' });

        // Every admitted path must be a record the repository intends to carry: the trace under `.kata/tasks/<id>/` or the
        // knowledge under `.kata/wiki/`. Machinery (worktrees, runtime, locks, evidence) must never be admitted.
        const admitted = listed
            .split('\n')
            .map((line) => line.replace(/^add '/, '').replace(/'$/, ''))
            .filter((line) => line.startsWith('.kata/'));
        expect(admitted.length).toBeGreaterThan(0);

        const machinery = admitted.filter(
            (path) =>
                path.startsWith('.kata/worktrees/')
                || path.startsWith('.kata/runtime/')
                || path.startsWith('.kata/locks/')
                || path.startsWith('.kata/evidence/'),
        );
        expect(machinery, 'machinery must not be admitted by the whitelist').toEqual([]);

        const admittedTraces = admitted.filter((path) => path.startsWith('.kata/tasks/'));
        expect(admittedTraces.length).toBeGreaterThan(0);
    });

    it('the two tables that must agree are actually compared', async () => {
        // **This is the half that was nominal.** `repository-identity.ts` says "the two are checked against each other by
        // `owner-rule-covers-evidence-and-trace.test.ts`" — and the check above read git's answer against a hand-written
        // machinery list, never calling `isIgnoredRepositoryPath`. So the sentence was a claim about a check that did not
        // exist, which is the defect shape this change keeps meeting. The comparison is now the two functions' own
        // answers, and the deliberate difference is stated rather than assumed away:
        //
        //   `.gitignore`      decides what git carries          (the trace is admitted by name)
        //   identity/drift    decides what counts as the change (records are not the change — a seal that counted them
        //                                                        would be voided by the record it just wrote)
        //
        // They therefore *disagree* for records on purpose. What must hold is that the disagreement is total and named:
        // every path git admits under `.kata/` is excluded from identity, and nothing else under `.kata/` is admitted.
        const { execFileSync } = await import('node:child_process');
        const { isIgnoredRepositoryPath } = await import('../../src/core/repository-identity.js');
        const repoRoot = '/data/work/ahaeureka/k2skills/kata';
        const listed = execFileSync('git', ['add', '-An', '.kata/'], { cwd: repoRoot, encoding: 'utf8' });
        const admitted = listed
            .split('\n')
            .map((line) => line.replace(/^add '/, '').replace(/'$/, ''))
            .filter((line) => line.startsWith('.kata/'));

        expect(admitted.length).toBeGreaterThan(0);
        const admittedButCountedAsChange = admitted.filter((path) => !isIgnoredRepositoryPath(path));
        expect(
            admittedButCountedAsChange,
            'a path git carries and identity also counts is the seal-voiding case: the record would be part of the change',
        ).toEqual([]);
    });
});
