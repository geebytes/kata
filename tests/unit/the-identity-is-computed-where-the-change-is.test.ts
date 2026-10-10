import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { symlink } from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { computePathDigests, readTaskRevision, revisionStatus } from '../../src/workflow/revision.js';
import { readCurrentTaskRevisionState } from '../../src/workflow/revision.js';

/**
 * **AC-1 — the sealed identity describes the tree the change is in.**
 *
 * The seal used to compute the revision's identity inside the execution sandbox: `contentRoot: sandbox.root` with
 * `contentDigests: sandbox.contentDigests` (`orchestrator.ts:674-679`). The sandbox is `git worktree add --detach HEAD`
 * plus an overlay built by `listRepositoryFiles`, and that walk **refuses paths the identity policy calls never-content** —
 * `.llmwiki` among them (`repository-identity.ts:37`). But `feedOwnedTree` hashes a **declared** path *without* that filter,
 * by design ("the filter applies to what the walk descends into, never to what was declared").
 *
 * So for a declaration that names such a path, the identity recorded the **sandbox's** view — the committed version, or
 * `[missing]` when the file is untracked — while `verify` recomputed the same hash over the author's tree
 * (`revision.ts:388-391`). Measured downstream: a change declaring three `.llmwiki/**` paths, of which one recorded exactly
 * `sha256('[missing]')`, reported `revision_superseded` on every run — and **re-sealing could not help**, because every seal
 * reproduced the same asymmetry. That is a gate whose named remedy cannot be executed.
 *
 * The shape of the case matters as much as the assertion: the declaration holds **three** paths and only **two** of them are
 * dirty in the ways that used to be invisible (one untracked, one modified-but-uncommitted, one untouched and committed).
 * A single-path fixture would pass under the defect.
 */
const execFileAsync = promisify(execFile);
const roots: string[] = [];
const taskId = 'identity-where-the-change-is';

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(root: string, args: string[]): Promise<void> {
    await execFileAsync('git', args, { cwd: root });
}

/**
 * A repository with three declared paths, committed as a baseline, then moved in the two ways the sandbox cannot see.
 *
 * `.llmwiki/` is the real name from the incident, and it is in the identity policy's never-content table
 * (`repository-identity.ts:37` `llmwikiDirName`) — which is what makes the sandbox's overlay **skip** it: the declared
 * content exists in the author tree and in HEAD, but never enters the sandbox. A directory the policy allows would be
 * overlaid and the defect would not reproduce, so the name is load-bearing, not decoration.
 */
async function fixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-identity-'));
    roots.push(root);
    await git(root, ['init', '-q']);
    await git(root, ['config', 'user.email', 'kata@example.test']);
    await git(root, ['config', 'user.name', 'Kata Test']);
    await initLayout(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, '.llmwiki'), { recursive: true });
    await writeFile(join(root, 'src', 'declared.ts'), 'export const declared = 1;\n');
    await writeFile(join(root, '.llmwiki', 'committed.md'), '# committed\n');
    await writeFile(join(root, '.llmwiki', 'edited.md'), '# the version in HEAD\n');
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-qm', 'baseline']);

    // Two of the three declared paths move, in the two ways the sandbox could not represent:
    await writeFile(join(root, '.llmwiki', 'edited.md'), '# edited after the commit, still uncommitted\n');
    await writeFile(join(root, '.llmwiki', 'untracked.md'), '# never committed at all\n');

    await runCommand('open', taskId, root, {
        title: 'Identity fixture',
        acceptance: [{ id: 'AC-1', statement: 'The identity describes the tree the change is in.' }],
    });
    await runCommand('design', taskId, root);
    return root;
}

const declared = ['.llmwiki/committed.md', '.llmwiki/edited.md', '.llmwiki/untracked.md'];

describe('the sealed identity is computed where the change is', () => {
    it('records the author tree for a declared path that is untracked or newer than HEAD', async () => {
        const root = await fixture();
        const check = { id: 'trivial', name: 'trivial', kind: 'test' as const, command: process.execPath, cwd: root, args: ['-e', 'process.exit(0)'] };

        const sealed = await runCommand('build', taskId, root, { seal: true, ownedPaths: declared, checks: [check] });
        expect(sealed.success, JSON.stringify(sealed).slice(0, 400)).toBe(true);

        const current = await readCurrentTaskRevisionState(root, taskId);
        expect(current.kind).toBe('current');
        if (current.kind !== 'current') return;
        const revision = await readTaskRevision(root, taskId, current.revision.id);
        expect(revision, 'the revision the pointer names is stored').toBeDefined();

        // **The load-bearing assertion**: the identity names the content an operator can see. Recomputing it from the author
        // tree must agree — which is exactly what `verify` does, and what used to fail for every run.
        const status = await revisionStatus(root, revision!, taskId);
        expect(status.status, `status after sealing: ${JSON.stringify(status)}`).toBe('current');

        // And the two dirty paths are recorded with their real digests, not with the sandbox's view of them.
        const digests = revision!.pathDigests ?? {};
        expect(Object.keys(digests).sort()).toEqual([...declared].sort());
        const missingSentinel = (await import('../../src/core/hash.js')).hashContent('[missing]');
        expect(digests['.llmwiki/untracked.md']).not.toBe(missingSentinel);
        expect(digests['.llmwiki/edited.md']).not.toBe(missingSentinel);
    }, 120_000);

    it('still reports a superseded revision when declared content really moves after the seal', async () => {
        const root = await fixture();
        const check = { id: 'trivial', name: 'trivial', kind: 'test' as const, command: process.execPath, cwd: root, args: ['-e', 'process.exit(0)'] };
        expect((await runCommand('build', taskId, root, { seal: true, ownedPaths: declared, checks: [check] })).success).toBe(true);

        // A real move, after the seal: the control that keeps the fix from becoming "never report drift".
        await writeFile(join(root, '.llmwiki', 'committed.md'), '# changed after the seal\n');

        const current = await readCurrentTaskRevisionState(root, taskId);
        expect(current.kind).toBe('current');
        if (current.kind !== 'current') return;
        const revision = await readTaskRevision(root, taskId, current.revision.id);
        const status = await revisionStatus(root, revision!, taskId);

        expect(status.status).not.toBe('current');
    }, 120_000);

    it('still runs the declared checks in the sandbox, so a check that writes cannot reach the repository', async () => {
        // **The claim this change must not have traded away.** Computing the identity from the author tree removed the one
        // reason the sandbox was under the identity's computation; it must not have removed the sandbox from the *checks*, and
        // the difference is observable: a check that writes a file into its own working directory leaves the author tree
        // untouched, and the identity recorded for a declared path is the author's content rather than whatever a check left
        // behind. (Measured before this case existed: reverting the check mapping so the commands run where the author is did
        // not redden anything.)
        const root = await fixture();
        const writer = {
            id: 'writes-into-its-cwd',
            name: 'writes-into-its-cwd',
            kind: 'test' as const,
            command: process.execPath,
            cwd: root,
            args: ['-e', 'require("node:fs").writeFileSync("check-side-effect.txt", "written by the check")'],
        };

        const sealed = await runCommand('build', taskId, root, { seal: true, ownedPaths: declared, checks: [writer] });
        expect(sealed.success, JSON.stringify(sealed).slice(0, 300)).toBe(true);

        // The check's own file is not in the repository.
        await expect(readFile(join(root, 'check-side-effect.txt'), 'utf8')).rejects.toThrow();
        // And the identity still describes the author's declared content: the two dirty paths are named with their real
        // digests, which is what would break if the identity were taken after the checks ran somewhere that saw them.
        const current = await readCurrentTaskRevisionState(root, taskId);
        expect(current.kind).toBe('current');
        if (current.kind !== 'current') return;
        const revision = (await readTaskRevision(root, taskId, current.revision.id))!;
        expect((await revisionStatus(root, revision, taskId)).status).toBe('current');
    }, 120_000);

    it('catches a check that overwrites a DECLARED never-content path, which the repository walk cannot see', async () => {
        // **The first version of the re-check asked the wrong question.** It compared `computeContentDigests` — the repository
        // walk — which excludes exactly the paths the identity policy calls never-content, and a declaration may still name
        // them. An independent round measured the gap: a check overwrote a declared `.llmwiki/**` path, the seal reported
        // success, and the revision it minted was immediately `superseded`. The re-check now asks the identity's own question
        // (`computeBothOwnedDigests`, the function that wrote `pathDigests`) as well as the repository's.
        const root = await fixture();
        const clobber = {
            id: 'clobbers-a-declared-never-content-path',
            name: 'clobbers-a-declared-never-content-path',
            kind: 'test' as const,
            command: process.execPath,
            cwd: root,
            args: [
                '-e',
                'const { execSync } = require("node:child_process"); const path = require("node:path");'
                + ' const common = execSync("git rev-parse --git-common-dir").toString().trim();'
                + ' const authorRoot = path.dirname(path.resolve(process.cwd(), common));'
                + ' require("node:fs").writeFileSync(path.join(authorRoot, ".llmwiki", "edited.md"), "# MUTATED BY CHECK\\n");',
            ],
        };

        const sealed = await runCommand('build', taskId, root, { seal: true, ownedPaths: declared, checks: [clobber] });

        expect(sealed.success, `seal answered: ${JSON.stringify(sealed).slice(0, 400)}`).toBe(false);
        expect((sealed.diagnostics as { reason?: string; declaredMoved?: string[] } | undefined)?.reason).toBe('repository_moved_during_checks');
        expect((sealed.diagnostics as { declaredMoved?: string[] } | undefined)?.declaredMoved).toContain('.llmwiki/edited.md');
    }, 120_000);

    it('refuses to seal when a check reaches the repository, instead of certifying content that no longer exists', async () => {
        // **The sandbox is a rewrite layer, not a jail, and the seal has to survive that.** `checksForExecutionSandbox`
        // rewrites the author root's literal occurrences in command, args, cwd and env — but a check that *resolves* the root
        // still reaches it: the sandbox worktree's git common dir points into the author checkout, so
        // `dirname $(git rev-parse --git-common-dir)` is the author root. An independent round measured what followed: a check
        // overwrote a declared file, the seal reported success, and `revisionStatus` then said `superseded` — the seal had
        // manufactured the drift its own identity refers to, and its report was stale the moment it was written.
        const root = await fixture();
        // A tracked, committed, declared path for the check to clobber — the `.llmwiki` paths above are never-content, so they
        // would not be in the identity at all.
        await writeFile(join(root, 'src', 'declared.ts'), 'export const declared = 1;\n');
        await git(root, ['add', '-A']);
        await git(root, ['commit', '-qm', 'declared file']);
        const clobber = {
            id: 'escapes-into-the-repository',
            name: 'escapes-into-the-repository',
            kind: 'test' as const,
            command: process.execPath,
            cwd: root,
            args: [
                '-e',
                'const { execSync } = require("node:child_process"); const path = require("node:path");'
                + ' const common = execSync("git rev-parse --git-common-dir").toString().trim();'
                + ' const authorRoot = path.dirname(path.resolve(process.cwd(), common));'
                + ' require("node:fs").writeFileSync(path.join(authorRoot, "src", "declared.ts"), "export const declared = 2;\\n");',
            ],
        };

        const sealed = await runCommand('build', taskId, root, { seal: true, ownedPaths: [...declared, 'src/declared.ts'], checks: [clobber] });

        expect(sealed.success, `seal answered: ${JSON.stringify(sealed).slice(0, 400)}`).toBe(false);
        expect(String(sealed.error)).toContain('moved while the checks ran');
        expect((sealed.diagnostics as { reason?: string } | undefined)?.reason).toBe('repository_moved_during_checks');
        // And the seal named the path, so the operator can see which check wrote where instead of hunting for it.
        expect(JSON.stringify(sealed.diagnostics)).toContain('src/declared.ts');
    }, 120_000);

    it('refuses a declaration that expands to nothing, instead of minting an identity with no content', async () => {
        // **The closing half of the hole round 3 measured.** A declared directory whose name the content policy calls
        // never-content (`.llmwiki/`, `dist/`, a cache) expands to nothing, so the seal used to mint a revision whose
        // `pathDigests` was empty — and a check that resolved the author root and wrote into that directory moved **no**
        // surface: `success: true`, `revisionStatus` `current`, the write on disk.
        //
        // The other candidate repair — recording such a root's contents whatever the policy says — was measured wrong too
        // (round 4): it made the same physical directory answer differently depending on how the declaration was spelled
        // (`build/` recorded its contents, while a git-ignored `build/*` inside a declared directory was excluded). So the
        // rule is one rule — what a declaration names is expanded under the repository's own content policy — and a
        // declaration that covers nothing is refused with the reason and the way forward.
        const root = await fixture();
        const check = { id: 'trivial', name: 'trivial', kind: 'test' as const, command: process.execPath, cwd: root, args: ['-e', 'process.exit(0)'] };

        const refused = await runCommand('build', taskId, root, { seal: true, ownedPaths: ['.llmwiki'], checks: [check] });

        expect(refused.success, `seal answered: ${JSON.stringify(refused).slice(0, 300)}`).toBe(false);
        expect(String(refused.error)).toContain('The declaration covers no files');
        expect(String(refused.error)).toContain('.llmwiki');
        expect((refused.diagnostics as { reason?: string } | undefined)?.reason).toBe('declaration_covers_no_content');
        // No revision was minted for it, so there is nothing whose identity silently covers zero content.
        expect(existsSync(join(root, '.kata', 'tasks', taskId, 'current-revision.json'))).toBe(false);
        // And the ledger answers the same way for the same declaration: reported as never-content, refused by name.
        const { declaredContentPaths } = await import('../../src/core/repository-identity.js');
        const ledgerSide = await declaredContentPaths(root, ['.llmwiki']);
        expect(ledgerSide.paths).toEqual([]);
        expect(ledgerSide.neverContent).toEqual(['.llmwiki']);
    }, 120_000);

    it('excludes a git-ignored descendant of a declared directory, and refuses it as a declaration of its own', async () => {
        // **Both spellings, one answer (round 4's major).** `build/` declared recorded its contents while a git-ignored
        // `build/*` inside a declared directory was excluded, so the same physical fact had two answers depending on how the
        // operator spelled the declaration. Under the uniform rule the descendant is not content, and naming it directly is
        // refused rather than silently recorded.
        const root = await fixture();
        await writeFile(join(root, '.gitignore'), '*.log\n');
        await writeFile(join(root, 'src', 'trace.log'), 'a build artifact\n');
        await git(root, ['add', '.gitignore']);
        await git(root, ['commit', '-qm', 'ignore logs']);

        // Declaring the directory records its content files and not the ignored descendant.
        const check = { id: 'trivial', name: 'trivial', kind: 'test' as const, command: process.execPath, cwd: root, args: ['-e', 'process.exit(0)'] };
        const sealed = await runCommand('build', taskId, root, { seal: true, ownedPaths: ['src'], checks: [check] });
        expect(sealed.success, JSON.stringify(sealed).slice(0, 300)).toBe(true);
        const current = await readCurrentTaskRevisionState(root, taskId);
        expect(current.kind).toBe('current');
        if (current.kind !== 'current') return;
        const revision = (await readTaskRevision(root, taskId, current.revision.id))!;
        const keys = Object.keys(revision.pathDigests ?? {});
        expect(keys).toContain('src/declared.ts');
        expect(keys).not.toContain('src/trace.log');

        // **A *file* is recorded whatever its name; a directory is expanded under the policy.** The same rule, stated for the
        // other spelling — so the ignored artifact is excluded from a declared directory and recorded when the operator names
        // it directly. Driven on a second fixture, because a seal adopts the declaration the task already carries.
        const second = await fixture();
        await writeFile(join(second, '.gitignore'), '*.log\n');
        await writeFile(join(second, 'src', 'trace.log'), 'a build artifact\n');
        await git(second, ['add', '.gitignore']);
        await git(second, ['commit', '-qm', 'ignore logs']);
        const trivial = { id: 'trivial', name: 'trivial', kind: 'test' as const, command: process.execPath, cwd: second, args: ['-e', 'process.exit(0)'] };

        const named = await runCommand('build', taskId, second, { seal: true, ownedPaths: ['src/trace.log'], checks: [trivial] });
        expect(named.success, JSON.stringify(named).slice(0, 300)).toBe(true);
        const namedCurrent = await readCurrentTaskRevisionState(second, taskId);
        expect(namedCurrent.kind).toBe('current');
        if (namedCurrent.kind !== 'current') return;
        const namedRevision = (await readTaskRevision(second, taskId, namedCurrent.revision.id))!;
        expect(Object.keys(namedRevision.pathDigests ?? {})).toEqual(['src/trace.log']);
    }, 120_000);

    it('catches a check that writes an UNDECLARED path, which the declared comparison cannot see', async () => {
        // **The repository half of the re-check needs its own witness.** The two comparisons answer two questions — did the
        // *declared* content move, and did anything else in the repository move — and a case for each keeps them both honest:
        // measured, removing the repository half from the refusal condition left every case green, because the declared cases
        // were all satisfied by the other half. This is the escape the sandbox cannot prevent (it rewrites the author root's
        // literal occurrences; a check that *resolves* the root still reaches it), writing a path nobody declared.
        const root = await fixture();
        const check = { id: 'trivial', name: 'trivial', kind: 'test' as const, command: process.execPath, cwd: root, args: ['-e', 'process.exit(0)'] };
        const escapedName = 'escaped-by-check.txt';
        const escape = {
            id: 'writes-an-undeclared-path',
            name: 'writes-an-undeclared-path',
            kind: 'test' as const,
            command: process.execPath,
            cwd: root,
            args: [
                '-e',
                'const { execSync } = require("node:child_process"); const path = require("node:path");'
                + ' const common = execSync("git rev-parse --git-common-dir").toString().trim();'
                + ' const authorRoot = path.dirname(path.resolve(process.cwd(), common));'
                + ` require("node:fs").writeFileSync(path.join(authorRoot, "${escapedName}"), "written by the check\\n");`,
            ],
        };

        const sealed = await runCommand('build', taskId, root, { seal: true, ownedPaths: declared, checks: [check, escape] });

        expect(sealed.success, `seal answered: ${JSON.stringify(sealed).slice(0, 400)}`).toBe(false);
        const diagnostics = sealed.diagnostics as { reason?: string; declaredMoved?: string[]; repositoryMoved?: string[] } | undefined;
        expect(diagnostics?.reason).toBe('repository_moved_during_checks');
        expect(diagnostics?.repositoryMoved).toContain(escapedName);
        // And it is reported as the repository half rather than the declared half: the write moved a path the declaration
        // never named, so the two facts stay distinguishable in the payload.
        expect(diagnostics?.declaredMoved).toEqual([]);
    }, 120_000);

    it('answers the same for an ignored directory however the repository spells the ignore rule', async () => {
        // **R5-F1: the answer depended on the repository's own `.gitignore` spelling.** `git status --ignored=matching` reports
        // the directory `build/` for the pattern `build/` and each of its files for `build/*`, so pruned-by-entry was true in
        // one spelling and false in the other: the same declared set was recorded under one and refused as covering nothing
        // under the other. The rule now asks about the path *or any ancestor*, which is also git's own semantics.
        const spellings: Array<[string, string, string[]]> = [
            ['build/', 'build', ['build/top.js']],
            ['build/*', 'build', []],
        ];
        const answers: Array<{ spelling: string; keys: string[]; refused: boolean }> = [];
        for (const [ignoreRule, declaration] of spellings) {
            const root = await fixture();
            await writeFile(join(root, '.gitignore'), `${ignoreRule}\n`);
            await mkdir(join(root, 'build'), { recursive: true });
            await writeFile(join(root, 'build', 'top.js'), 'built\n');
            await git(root, ['add', '.gitignore']);
            await git(root, ['commit', '-qm', `ignore rule ${ignoreRule}`]);
            const check = { id: 'trivial', name: 'trivial', kind: 'test' as const, command: process.execPath, cwd: root, args: ['-e', 'process.exit(0)'] };

            const sealed = await runCommand('build', taskId, root, { seal: true, ownedPaths: [declaration], checks: [check] });
            const current = await readCurrentTaskRevisionState(root, taskId);
            if (current.kind === 'current') {
                const revision = (await readTaskRevision(root, taskId, current.revision.id))!;
                answers.push({ spelling: ignoreRule, keys: Object.keys(revision.pathDigests ?? {}).sort(), refused: false });
            } else {
                answers.push({ spelling: ignoreRule, keys: [], refused: sealed.success === false });
            }
        }

        // Both spellings agree: the ignored directory is not content, so the declaration covers nothing and both refuse.
        expect(answers.map((answer) => answer.keys), JSON.stringify(answers)).toEqual([[], []]);
        expect(answers.every((answer) => answer.refused), JSON.stringify(answers)).toBe(true);
    }, 180_000);

    it('answers the same for a declared path that does not exist, and reports a link that leaves the repository', async () => {
        // **Two more shapes where the readers used to disagree (round 5).** A declaration whose path does not exist expanded
        // to a `[missing]` sentinel, which is not content, so the seal minted a revision while the ledger refused the same
        // declaration. And a declared symlink was followed lexically: a link pointing inside the repository recorded
        // descendants its target excludes (a third answer for one tree) and a link pointing outside the repository entered
        // under a repository-relative key, which the declaration's containment rule promises cannot happen.
        const root = await fixture();
        const check = { id: 'trivial', name: 'trivial', kind: 'test' as const, command: process.execPath, cwd: root, args: ['-e', 'process.exit(0)'] };

        const absent = await runCommand('build', taskId, root, { seal: true, ownedPaths: ['src/does-not-exist.ts'], checks: [check] });
        const { declaredContentPaths } = await import('../../src/core/repository-identity.js');
        const ledgerSide = await declaredContentPaths(root, ['src/does-not-exist.ts']);

        expect(absent.success, JSON.stringify(absent).slice(0, 300)).toBe(false);
        expect((absent.diagnostics as { reason?: string } | undefined)?.reason).toBe('declaration_covers_no_content');
        expect(ledgerSide.unreadable).toEqual(['src/does-not-exist.ts']);

        // A link to a directory inside the repository answers exactly as its target does.
        const second = await fixture();
        await mkdir(join(second, 'notes'), { recursive: true });
        await writeFile(join(second, 'notes', 'a.md'), '# a note\n');
        await git(second, ['add', '-A']);
        await git(second, ['commit', '-qm', 'a directory for the link to point at']);
        await symlink(join(second, 'notes'), join(second, 'link-to-notes'));
        await git(second, ['add', 'link-to-notes']);
        await git(second, ['commit', '-qm', 'a link to that directory']);

        const linkCheck = { id: 'trivial', name: 'trivial', kind: 'test' as const, command: process.execPath, cwd: second, args: ['-e', 'process.exit(0)'] };
        const viaLink = await runCommand('build', taskId, second, { seal: true, ownedPaths: ['link-to-notes'], checks: [linkCheck] });
        expect(viaLink.success, JSON.stringify(viaLink).slice(0, 300)).toBe(true);
        const target = await computePathDigests(second, ['notes']);
        const throughLink = await computePathDigests(second, ['link-to-notes']);
        expect(Object.keys(throughLink).sort(), 'the link answers as its target does').toEqual(Object.keys(target).sort());

        // A link that leaves the repository is reported, not recorded under a repository-relative key.
        const outside = await mkdtemp(join(tmpdir(), 'kata-outside-'));
        roots.push(outside);
        await writeFile(join(outside, 'secret.txt'), 'outside\n');
        const third = await fixture();
        await symlink(join(outside, 'secret.txt'), join(third, 'escaping-link'));
        const escapingCheck = { id: 'trivial', name: 'trivial', kind: 'test' as const, command: process.execPath, cwd: third, args: ['-e', 'process.exit(0)'] };
        const escaping = await runCommand('build', taskId, third, { seal: true, ownedPaths: ['escaping-link'], checks: [escapingCheck] });
        const escapingRead = await declaredContentPaths(third, ['escaping-link']);
        expect(escaping.success, JSON.stringify(escaping).slice(0, 300)).toBe(false);
        expect(escapingRead.unreadable).toEqual(['escaping-link']);
        expect(JSON.stringify(escaping)).not.toContain('secret.txt');
    }, 180_000);

    it('does not read through a declared link whose target is a directory outside the repository', async () => {
        // **Round 6's blocking finding, and the branch order it exposed.** `stat` follows symlinks, so `entry.isDirectory()` is
        // true for a link whose target is a directory — and that check came *before* the escape check, which made the escape
        // branch dead code for exactly this shape. Measured: the seal minted a revision whose
        // `pathDigests['link-dir-out/x.txt']` was the digest of bytes **outside the repository**, while the ledger refused the
        // same declaration as unreadable. A link to the repository root was recorded as the whole tree the same way.
        const outsideDirectory = await mkdtemp(join(tmpdir(), 'kata-outside-dir-'));
        roots.push(outsideDirectory);
        await writeFile(join(outsideDirectory, 'x.txt'), 'OUTSIDE CONTENT\n');

        const root = await fixture();
        const check = { id: 'trivial', name: 'trivial', kind: 'test' as const, command: process.execPath, cwd: root, args: ['-e', 'process.exit(0)'] };
        await symlink(outsideDirectory, join(root, 'link-dir-out'));

        const refused = await runCommand('build', taskId, root, { seal: true, ownedPaths: ['link-dir-out'], checks: [check] });
        const { declaredContentPaths } = await import('../../src/core/repository-identity.js');
        const ledgerSide = await declaredContentPaths(root, ['link-dir-out']);

        expect(refused.success, `seal answered: ${JSON.stringify(refused).slice(0, 400)}`).toBe(false);
        expect((refused.diagnostics as { reason?: string } | undefined)?.reason).toBe('declaration_covers_no_content');
        expect(ledgerSide.unreadable).toEqual(['link-dir-out']);
        // The outside bytes are nowhere in what the seal reported, which is the whole point of refusing.
        expect(JSON.stringify(refused)).not.toContain('OUTSIDE CONTENT');

        // A link to the repository itself is the same shape: it is not content, and the tree is not recorded under its name.
        const second = await fixture();
        await symlink(second, join(second, 'link-to-root'));
        const rootLink = await runCommand('build', taskId, second, { seal: true, ownedPaths: ['link-to-root'], checks: [{ ...check, cwd: second }] });
        expect(rootLink.success, JSON.stringify(rootLink).slice(0, 300)).toBe(false);
        expect(JSON.stringify(rootLink)).not.toContain('sentinel-of-self');
    }, 180_000);

    it('treats a file whose content is exactly a sentinel marker as content, and reports its deletion', async () => {
        // **Round 6's second major.** The seal decided "covers no content" by comparing digests against
        // `sha256('[missing]')`, so a real declared file containing exactly `[missing]` was refused by the seal while the same
        // declaration was accepted by the ledger — and, in a mixed declaration, that file was indistinguishable from a deleted
        // one: deleting it left `revisionStatus` reporting `current` and `differingPaths` empty, so a real move went
        // unreported. A path with no content no longer produces a digest entry at all, so the map answers the question without
        // any sentinel comparison.
        const root = await fixture();
        await writeFile(join(root, 'src', 'marker.txt'), '[missing]');
        await git(root, ['add', 'src/marker.txt']);
        await git(root, ['commit', '-qm', 'a file whose bytes are a sentinel marker']);
        const check = { id: 'trivial', name: 'trivial', kind: 'test' as const, command: process.execPath, cwd: root, args: ['-e', 'process.exit(0)'] };

        const sealed = await runCommand('build', taskId, root, { seal: true, ownedPaths: ['src/marker.txt', 'src/declared.ts'], checks: [check] });
        expect(sealed.success, `seal answered: ${JSON.stringify(sealed).slice(0, 300)}`).toBe(true);
        const current = await readCurrentTaskRevisionState(root, taskId);
        expect(current.kind).toBe('current');
        if (current.kind !== 'current') return;
        const revision = (await readTaskRevision(root, taskId, current.revision.id))!;
        expect(Object.keys(revision.pathDigests ?? {}).sort()).toEqual(['src/declared.ts', 'src/marker.txt']);
        expect(await revisionStatus(root, revision, taskId).then((status) => status.status)).toBe('current');

        // Deleting it is a real move, and it is reported with both sides.
        await rm(join(root, 'src', 'marker.txt'));
        const after = await revisionStatus(root, revision, taskId);
        expect(after.status, JSON.stringify(after)).toBe('superseded');
        if (after.status !== 'superseded') return;
        const entry = after.differingPaths.find((candidate) => candidate.path === 'src/marker.txt');
        expect(entry?.observed).toBeNull();
        expect(typeof entry?.recorded).toBe('string');
        // And the deleted path is no longer content for either reader, which is the condition the seal refuses on (driven end
        // to end in the case above; here the task record already carries the wider declaration, so the CLI would reuse it).
        expect(await computePathDigests(root, ['src/marker.txt'])).toEqual({});
        const { declaredContentPaths } = await import('../../src/core/repository-identity.js');
        expect((await declaredContentPaths(root, ['src/marker.txt'])).paths).toEqual([]);
    }, 180_000);

    it('hashes an entered scope exactly as it hashes a declared one, entry kinds included', async () => {
        // **The two streams are one derivation, and that is asserted directly.** The evidence scope hash is compared against the
        // revision manifest at verify time (`checkFreshness`), so a second stream that agrees only by accident makes every
        // sealed evidence stale — measured when the entry-kind tags were added to the manifest alone: 12 e2e cases failed.
        // Asserting the equality here rather than through the suite that noticed is what makes the property a guard: it costs
        // milliseconds, needs no built bundle, and reddens whichever side diverges.
        const root = await fixture();
        const check = { id: 'trivial', name: 'trivial', kind: 'test' as const, command: process.execPath, cwd: root, args: ['-e', 'process.exit(0)'] };
        const owned = ['src', 'src/declared.ts', 'src/does-not-exist.ts', '.llmwiki'];
        const sealed = await runCommand('build', taskId, root, { seal: true, ownedPaths: owned, checks: [check] });
        expect(sealed.success, JSON.stringify(sealed).slice(0, 300)).toBe(true);

        const current = await readCurrentTaskRevisionState(root, taskId);
        expect(current.kind).toBe('current');
        if (current.kind !== 'current') return;
        const revision = (await readTaskRevision(root, taskId, current.revision.id))!;

        const { computeScopeHash } = await import('../../src/quality/evidence.js');
        const { computeBothOwnedDigests } = await import('../../src/workflow/revision.js');
        // The revision the seal minted for this declaration …
        expect(await computeScopeHash(root, owned)).toBe(revision.manifestHash);
        // … and every shape that reaches the stream, asked of the two functions directly (a second seal in this test would
        // first consume a repair entry, so the property is asserted where it lives rather than through the CLI again): a
        // directory, a declared file, a missing path, and a never-content root.
        for (const paths of [owned, ['src'], ['src/declared.ts'], ['src/does-not-exist.ts'], ['.llmwiki']]) {
            expect(await computeScopeHash(root, paths), paths.join(',')).toBe((await computeBothOwnedDigests(root, paths)).manifestHash);
        }
    }, 180_000);
});
