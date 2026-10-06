import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

    it('answers from the path shape when the worktree holds no record directory', () => {
        // **The shape the defect hid behind.** Every fixture in this file created `.kata/tasks/<id>/` inside the worktree,
        // which is not what a worktree a task is *working in* looks like: the records live in the checkout that owns it, so
        // the record walk finds no task id and `recordOwner` answered `undefined`. Read as "no owner", that put the Wiki
        // store — and the evidence store — back inside the worktree, which is exactly the per-root copy this rule forbids.
        const primary = repo('bare-worktree');
        seedTask(primary, 'held');
        const worktree = join(primary, '.kata', 'worktrees', 'bare');
        mkdirSync(join(worktree, 'src'), { recursive: true });

        const owner = recordOwner({ root: worktree });
        expect(owner.taskId, 'a bare worktree carries no task id').toBeUndefined();
        expect(owner.ownerRoot, 'the path shape still names the checkout that holds the worktree').toBe(primary);
        expect(wikiDir(worktree)).toBe(join(primary, '.kata', 'wiki'));
        // The same derivation answers the evidence store, which is the same question one surface over.
        expect(evidenceDir(worktree)).toBe(join(primary, '.kata', 'evidence'));
    });

    it('recognises a linked worktree that git lists outside .kata/worktrees', () => {
        // **The shape the docstring promised and the code never had.** `worktreeContaining` has always documented two
        // shapes — "the linked checkouts this repository creates under `.kata/worktrees/<dir>`, and a git worktree listed
        // by `git worktree list` (which is how a `--path` checkout appears)" — while its body was a pure path test. So a
        // checkout created with `worktree create --path`, or by hand with `git worktree add`, was not recognised: the
        // owner came back `undefined`, and both stores fell back into the worktree. Measured on the frozen revision as
        // challenge X1: `wiki candidate` answered the registered candidate from the primary and `[]` from this worktree.
        const primary = repo('path-worktree');
        seedTask(primary, 'a-task');
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: primary });
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: primary });
        // Deliberately not under `.kata/worktrees/`: this is the `--path` shape, which only git can name.
        const linked = `${primary}-linked`;
        execFileSync('git', ['worktree', 'add', '-q', '--detach', linked], { cwd: primary });
        roots.push(linked);

        const owner = recordOwner({ root: linked });
        expect(owner.worktreeRoot, 'git is the only source that names this shape').toBe(linked);
        expect(owner.ownerRoot, 'and its owner is the checkout git says it belongs to').toBe(primary);
        expect(wikiDir(linked)).toBe(join(primary, '.kata', 'wiki'));
        expect(evidenceDir(linked)).toBe(join(primary, '.kata', 'evidence'));
    });

    it('resolves a worktree to its owner even when the task it holds has no owner anywhere', () => {
        // **A task-less question must not be answered by a task-addressed derivation.** `wikiDir` and `evidenceDir` have
        // no task parameter; they used to supply `worktreeTaskId(start)` anyway, which reads the sorted-first task
        // directory the worktree happens to contain. When that task is one no checkout holds — the stranded state this
        // project handles through `worktreeOnlyRecords`/`recoverWorktreeRecords` — the owner walk found nothing and both
        // stores fell back inside the worktree, while `recordsRoot` for the task actually being worked on still answered
        // the owner. Measured on the frozen revision as challenge X2.
        const primary = repo('stranded-worktree');
        seedTask(primary, 'held');
        const worktree = join(primary, '.kata', 'worktrees', 'a-task');
        mkdirSync(join(worktree, '.kata', 'tasks', 'other-task'), { recursive: true });
        writeFileSync(join(worktree, '.kata', 'tasks', 'other-task', 'judge.json'), '{}\n');

        expect(recordOwner({ root: worktree }).ownerRoot, 'the worktree still belongs to its checkout').toBe(primary);
        expect(wikiDir(worktree)).toBe(join(primary, '.kata', 'wiki'));
        expect(evidenceDir(worktree)).toBe(join(primary, '.kata', 'evidence'));
        // The two surfaces agree again: the task being worked on is held by the same checkout.
        expect(recordsRoot(worktree, 'held')).toBe(primary);
    });

    it('walks past a linked worktree to the checkout that owns it', () => {
        // **A worktree can be created inside a worktree, through the product's own command.** `runWorktreeCommand`
        // resolves `resolveWorkspaceRoot()`, which answers the worktree the command stands in, and `createWorktree`
        // targets `join(worktreesDir(root), taskId)` — so `kata-cli worktree create` run from a linked checkout makes
        // `<outer>/.kata/worktrees/<id>`. The path above that checkout is the *outer linked worktree*, not the owner:
        // measured on the frozen revision as challenge X3, `wiki candidate` listed the candidate from the primary and
        // answered `[]` from the nested one, while `git worktree list` inside it named the primary as `main` — git was
        // never consulted, because the path answer was tried first and never checked for being a worktree itself.
        const primary = repo('nested');
        seedTask(primary, 'a-task');
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: primary });
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: primary });
        const outer = join(primary, '.kata', 'worktrees', 'outer');
        const inner = join(outer, '.kata', 'worktrees', 'inner');
        execFileSync('git', ['worktree', 'add', '-q', outer, '-b', 'outer'], { cwd: primary });
        execFileSync('git', ['worktree', 'add', '-q', inner, '-b', 'inner'], { cwd: primary });

        expect(recordOwner({ root: inner }).worktreeRoot, 'the innermost checkout is the one the caller is in').toBe(inner);
        expect(recordOwner({ root: inner }).ownerRoot, 'and its owner is the checkout that owns both').toBe(primary);
        expect(wikiDir(inner)).toBe(join(primary, '.kata', 'wiki'));
        expect(evidenceDir(inner)).toBe(join(primary, '.kata', 'evidence'));
    });

    it('uses git’s primary checkout when an outside-path worktree contains a nested worktree', () => {
        // **The path answer is only a fixture fallback; git is authoritative for a real linked checkout.** An outside
        // `git worktree add` checkout has no `.kata/worktrees` segment. If it creates the product’s nested shape, the
        // inner path does contain one — but the checkout above it is still a linked worktree, so it cannot own records.
        // The inner `.git` marker points at the primary and `git worktree list` names that primary as main.
        const primary = repo('outside-nested');
        seedTask(primary, 'a-task');
        writeFileSync(join(primary, 'README.md'), 'primary\n');
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'README.md'], { cwd: primary });
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: primary });
        const outer = `${primary}-outer`;
        const inner = join(outer, '.kata', 'worktrees', 'inner');
        execFileSync('git', ['worktree', 'add', '-q', '--detach', outer], { cwd: primary });
        roots.push(outer);
        mkdirSync(join(outer, '.kata', 'worktrees'), { recursive: true });
        execFileSync('git', ['worktree', 'add', '-q', '--detach', inner], { cwd: outer });

        const owner = recordOwner({ root: inner });
        expect(owner.worktreeRoot).toBe(inner);
        expect(owner.ownerRoot).toBe(primary);
        expect(wikiDir(inner)).toBe(join(primary, '.kata', 'wiki'));
        expect(evidenceDir(inner)).toBe(join(primary, '.kata', 'evidence'));
    });

    it('refuses a nested worktree when Git cannot name its outside-path linked parent', () => {
        // Git cannot name the inner checkout after its admin marker is broken. The outer checkout is still visibly linked
        // through its own marker, so path ownership must skip it rather than silently placing a store there.
        const primary = repo('outside-unnameable-nested');
        seedTask(primary, 'a-task');
        writeFileSync(join(primary, 'README.md'), 'primary\n');
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', 'README.md'], { cwd: primary });
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: primary });
        const outer = `${primary}-outer`;
        const inner = join(outer, '.kata', 'worktrees', 'inner');
        execFileSync('git', ['worktree', 'add', '-q', '--detach', outer], { cwd: primary });
        roots.push(outer);
        mkdirSync(join(outer, '.kata', 'worktrees'), { recursive: true });
        execFileSync('git', ['worktree', 'add', '-q', '--detach', inner], { cwd: outer });
        writeFileSync(join(inner, '.git'), 'gitdir: /nonexistent/primary/.git/worktrees/inner\n');

        const owner = recordOwner({ root: inner });
        expect(owner.worktreeRoot).toBe(inner);
        expect(owner.ownerRoot).toBeUndefined();
        expect(() => wikiDir(inner)).toThrow(/owner/i);
        expect(() => evidenceDir(inner)).toThrow(/owner/i);
    });

    it('answers with the worktree that holds the only copy of a task', () => {
        // **The documented fallback, restored.** `recordsRoot` says it in words — "When nothing else holds the task the
        // worktree is still used, because an unreachable record is worse than a remote one" — and this repository keeps
        // three mechanisms for the shape (`worktreeOnlyRecords`, `uniqueCopies`, `worktree recover`). The first repair
        // replaced the task-addressed branch with a path answer that never asked whether the checkout holds the task, so
        // a stranded task was read from a checkout with no state for it. Measured on the frozen revision as challenge X4:
        // `status --change <id>` from the worktree holding the task's only records failed with ENOENT under the primary.
        const primary = repo('stranded');
        seedTask(primary, 'held');
        const worktree = join(primary, '.kata', 'worktrees', 'wt');
        mkdirSync(join(worktree, '.kata', 'tasks', 'only-here'), { recursive: true });
        writeFileSync(
            join(worktree, '.kata', 'tasks', 'only-here', 'current-state.json'),
            `${JSON.stringify({ taskId: 'only-here', phase: 'implement' })}\n`,
        );

        const owner = recordOwner({ root: worktree, taskId: 'only-here' });
        expect(owner.ownerRoot, 'the only checkout holding it is the worktree itself').toBe(worktree);
        expect(recordsRoot(worktree, 'only-here')).toBe(worktree);
        // **The invariant every caller relies on**: a named owner holds the task. `ownerRoot` is documented as "the
        // checkout holding this record", and an answer that fails this is worse than `undefined`, because `undefined`
        // is the state `recordsRoot` has a documented answer for.
        expect(readdirSync(join(owner.ownerRoot!, '.kata', 'tasks', 'only-here')).length).toBeGreaterThan(0);
    });

    it('refuses rather than keeping a per-root store when a worktree cannot be named', () => {
        // **The one case `worktreeOwnerOf`'s docstring names, and the one the callers could not honour.** A checkout
        // whose `.git` is a file but whose admin directory is gone is still a linked worktree — the marker says so —
        // while git cannot answer, so no owner can be named. Reading `undefined` as "here" then keeps a per-root copy
        // inside the worktree, which is the fail-open direction this change removes. Measured on the frozen revision as
        // challenge X5: the primary listed the candidate and the worktree answered `[]`.
        const primary = repo('unnameable');
        seedTask(primary, 'a-task');
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: primary });
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: primary });
        const linked = `${primary}-linked`;
        execFileSync('git', ['worktree', 'add', '-q', linked, '-b', 'linked'], { cwd: primary });
        roots.push(linked);
        // The marker keeps its real shape — `gitdir: <primary>/.git/worktrees/<name>` — while the admin directory it
        // names is gone, which is what a moved or copied checkout looks like. git then fails, and the marker text is the
        // only thing left that says this is a linked worktree.
        writeFileSync(join(linked, '.git'), `gitdir: /nonexistent/primary/.git/worktrees/linked\n`);

        const owner = recordOwner({ root: linked });
        expect(owner.worktreeRoot, 'the marker still says this checkout is a linked worktree').toBe(linked);
        expect(owner.ownerRoot, 'and no owner can be named for it').toBeUndefined();
        expect(() => wikiDir(linked), 'so the store refuses instead of answering "here"').toThrow(/owner/i);
        expect(() => evidenceDir(linked)).toThrow(/owner/i);
    });

    it('says no owner rather than inventing one when the task is nowhere', () => {
        // The previous shapes returned the caller's directory when nothing held the task, which made "unknown" read as
        // "here" — and let a command run inside a worktree write records into the worktree.
        const primary = repo('absent');
        const owner = recordOwner({ root: primary, taskId: 'never-created' });
        expect(owner.ownerRoot, 'an absent task has no owner, and the answer says so').toBeUndefined();
    });
});
