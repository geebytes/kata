import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { readTaskRevision, revisionStatus } from '../../src/workflow/revision.js';
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
});
