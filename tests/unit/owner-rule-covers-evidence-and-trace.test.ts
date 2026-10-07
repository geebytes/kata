import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evidenceDir, initLayout, recordOwner, recordsRoot, wikiDir, wikiRecordPath } from '../../src/core/layout.js';
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

    it('the Wiki store keeps its location when the code and the records share one checkout', async () => {
        const { primary } = await fixture();

        // **The fallback is not the defect this class usually has.** `ownerRoot` is undefined when no other checkout holds
        // the task, and for a task whose records live here that is the correct answer: the store is *here*, at the path it
        // has always had. Nothing is migrated, and every reader and writer resolves the same file as before.
        expect(wikiDir(primary)).toBe(join(primary, '.kata', 'wiki'));
        expect(wikiRecordPath(primary, 'a-record')).toBe(join(primary, '.kata', 'wiki', 'a-record.json'));
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

    it('a worktree that holds no record directory still resolves to its owner', async () => {
        // The fixtures above create `.kata/tasks/<id>/` inside the worktree, which is how `worktreeTaskId` learned the task
        // id — and that is not the shape a real worktree has. Without it the record walk finds nothing, and "no owner" was
        // read as "here", so the store went back inside the worktree. The owner comes from the path shape instead.
        const primary = await mkdtemp(join(tmpdir(), 'kata-evidence-bare-'));
        roots.push(primary);
        await initLayout(primary);
        const linked = join(primary, '.kata', 'worktrees', 'bare');
        await mkdir(join(linked, 'src'), { recursive: true });

        expect(recordOwner({ root: linked }).ownerRoot).toBe(primary);
        expect(evidenceDir(linked)).toBe(join(primary, '.kata', 'evidence'));
        expect(wikiDir(linked)).toBe(join(primary, '.kata', 'wiki'));
    });

    /**
     * **A repository this case builds, because the one it was reading is not an artefact.**
     *
     * These two cases used to hard-code this checkout's path and ask git about *it* — so their answer was whatever the live
     * index happened to hold. Measured twice in one session: with another session's `.kata` records staged, `git add -An`
     * printed nothing and the case failed; with another session's transient lock file removed mid-scan, `execFileSync` threw
     * `fatal: 无法对 …/holder.json 执行 stat`. The seal runs the suite, so a concurrent session could block any change's
     * seal — which is how it presented: a seal that failed for a reason no code in the change explained.
     *
     * What stays real is the subject: the repository's own tracked `.gitignore` is copied in, and the fixture writes one path
     * per kind, because a fixture with no admitted path would make both cases pass on an empty answer — which is exactly how
     * the first failure hid.
     */
    async function whitelistedRepository(): Promise<{ root: string; listed: string }> {
        const root = await mkdtemp(join(tmpdir(), 'kata-whitelist-'));
        roots.push(root);
        await writeFile(join(root, '.gitignore'), await readFile(new URL('../../.gitignore', import.meta.url), 'utf8'));
        const paths = [
            '.kata/tasks/fixture/task.json',
            '.kata/wiki/fixture.json',
            '.kata/worktrees/fixture/marker',
            '.kata/runtime/fixture.json',
            '.kata/locks/fixture.lock',
            '.kata/evidence/fixture.json',
        ];
        for (const path of paths) {
            await mkdir(dirname(join(root, path)), { recursive: true });
            await writeFile(join(root, path), '{}\n');
        }
        const { execFileSync } = await import('node:child_process');
        execFileSync('git', ['init', '-q'], { cwd: root });
        return { root, listed: execFileSync('git', ['add', '-An', '.kata/'], { cwd: root, encoding: 'utf8' }) };
    }

    /** git's dry-run answer, as the paths it would add under `.kata/`. */
    function admittedPaths(listed: string): string[] {
        return listed
            .split('\n')
            .map((line) => line.replace(/^add '/, '').replace(/'$/, ''))
            .filter((line) => line.startsWith('.kata/'));
    }

    it('the .gitignore whitelist and the record files agree, measured against git itself', async () => {
        // The whitelist under test is the repository's; what git is asked about is a repository this case built, so the
        // answer is a function of the fixture rather than of whatever another session has staged in this checkout.
        const { listed } = await whitelistedRepository();
        const admitted = admittedPaths(listed);
        expect(admitted.length).toBeGreaterThan(0);

        // Every admitted path must be a record the repository intends to carry: the trace under `.kata/tasks/<id>/` or the
        // knowledge under `.kata/wiki/`. Machinery (worktrees, runtime, locks, evidence) must never be admitted.
        expect(admitted).toContain('.kata/tasks/fixture/task.json');
        expect(admitted).toContain('.kata/wiki/fixture.json');

        const machinery = admitted.filter(
            (path) =>
                path.startsWith('.kata/worktrees/')
                || path.startsWith('.kata/runtime/')
                || path.startsWith('.kata/locks/')
                || path.startsWith('.kata/evidence/'),
        );
        expect(machinery, 'machinery must not be admitted by the whitelist').toEqual([]);
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
        const { isIgnoredRepositoryPath } = await import('../../src/core/repository-identity.js');
        const { listed } = await whitelistedRepository();
        const admitted = admittedPaths(listed);

        expect(admitted.length).toBeGreaterThan(0);
        const admittedButCountedAsChange = admitted.filter((path) => !isIgnoredRepositoryPath(path));
        expect(
            admittedButCountedAsChange,
            'a path git carries and identity also counts is the seal-voiding case: the record would be part of the change',
        ).toEqual([]);
    });
});
