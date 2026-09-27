import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { readTask } from '../../src/core/task.js';
import { changeSurfaceAgainstWorkspace } from '../../src/quality/revision-delta.js';
import { readTaskRevision } from '../../src/workflow/revision.js';

/**
 * The audited surface has to follow the facts, not only the declaration.
 *
 * Two defects measured in one real change, both structural:
 *
 * 1. `kata-cli scope change --add <path> --reason "..."` records the decision in `scope-changes.json` and writes it
 *    **nowhere else**. `ownedPaths` is what a revision hashes and what a delta is computed over, so the recorded addition
 *    never took effect: six scope changes on one task, and every revision carried the same owned-path digest
 *    (`4522af1eaa…`). The CLI's own output compounds it — it says to run `kata-cli scope apply`, and no such subcommand
 *    exists. The tested answer is not "declare more carefully"; it is that a fact the repository already holds (which
 *    paths the revision changed) belongs in the delta surface, and a recorded decision has to be applied or refused.
 *
 * 2. A round that changed files outside its declared ownership reported it only in prose, so every round produced one
 *    `major` finding of the "the delta understates what changed" class. `changedOutsideOwnership` on the change record
 *    replaces that class with a list.
 */
describe('delta surface follows the change', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function tempRoot(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-delta-surface-'));
        roots.push(root);
        await initLayout(root);
        execFileSync('git', ['init', '--quiet'], { cwd: root });
        execFileSync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
        execFileSync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/owned.ts'), 'export const owned = 1;\n', 'utf8');
        await writeFile(join(root, 'src/outside.ts'), 'export const outside = 1;\n', 'utf8');
        await writeFile(join(root, '.kata-config.json'), `${JSON.stringify({ checks: [{ name: 'typecheck', command: 'true' }] })}\n`, 'utf8');
        execFileSync('git', ['add', '.'], { cwd: root });
        execFileSync('git', ['commit', '--quiet', '-m', 'base'], { cwd: root });
        return root;
    }

    it('reports the change surface even for a path no owned path covers', async () => {
        const root = await tempRoot();
        await runCommand('open', 'delta-task', root, {
            title: 'Delta surface',
            acceptance: [{ id: 'AC-1', statement: 'x' }],
            ownedPaths: ['src/owned.ts'],
        });
        await runCommand('design', 'delta-task', root);
        // The base revision covers only the declared path.
        const first = await runCommand('build', 'delta-task', root, { seal: true, checks: [{ id: 'typecheck', kind: 'typecheck', name: 'typecheck', command: 'true', expectExitCode: 0 }] });
        if (!first.success) throw new Error(`seal refused: ${first.error} :: ${JSON.stringify(first.diagnostics)}`);
        expect(first.success).toBe(true);
        const base = await readTaskRevision(root, 'delta-task', first.diagnostics?.revisionId as string);
        expect(base).toBeTruthy();

        // Now change a file outside ownership, and ask for the surface against the base.
        await writeFile(join(root, 'src/outside.ts'), 'export const outside = 2;\n', 'utf8');
        const surface = await changeSurfaceAgainstWorkspace(root, base!);
        expect(surface.status).toBe('available');
        if (surface.status === 'available') {
            // The fact: the file changed. A surface that only measured the base's owned set would report nothing here,
            // which is what let a round change the docs and the tests and call the delta bounded.
            expect(surface.changedPaths).toContain('src/outside.ts');
        }
    });

    it('applies a recorded scope change to ownedPaths, so the next revision hashes the grown surface', async () => {
        const root = await tempRoot();
        await runCommand('open', 'scope-task', root, {
            title: 'Scope applies',
            acceptance: [{ id: 'AC-1', statement: 'x' }],
            ownedPaths: ['src/owned.ts'],
        });
        await runCommand('design', 'scope-task', root);
        await runCommand('build', 'scope-task', root, { seal: true, checks: [{ id: 'typecheck', kind: 'typecheck', name: 'typecheck', command: 'true', expectExitCode: 0 }] });
        const before = await readTask(root, 'scope-task');
        expect(before.ownedPaths).toEqual(['src/owned.ts']);

        const { recordScopeChange } = await import('../../src/quality/scope-change.js');
        const recorded = await recordScopeChange(root, 'scope-task', {
            current: before.ownedPaths ?? [],
            next: ['src/owned.ts', 'src/outside.ts'],
            reason: 'the repair needed a path outside the declaration',
            by: 'kata-agent',
        });
        expect('refused' in recorded).toBe(false);
        if ('refused' in recorded) throw new Error(recorded.refused);

        // Applying the recorded decision is what makes it real. Recording alone left `ownedPaths` untouched for six
        // consecutive scope changes on the measured task.
        const { applyScopeChange } = await import('../../src/quality/scope-change.js');
        const applied = await applyScopeChange(root, 'scope-task', recorded.id);
        expect(applied.applied).toBe(true);
        expect(applied.ownedPaths).toEqual(['src/outside.ts', 'src/owned.ts']);

        const after = await readTask(root, 'scope-task');
        expect(after.ownedPaths).toEqual(['src/outside.ts', 'src/owned.ts']);
    });

    it('reports a path the round added and committed, which neither the base nor git status can see', async () => {
        // The independent pass measured this on the real task: the base revision's digest table has no entry for a
        // newly added file, and once the round commits, `git status` is clean - so the union of those two sources
        // omitted every added path. The issued brief then said "Added: (none)" while the shipped CLI's own comparison
        // named three added paths, and the reviewer was told a six-path surface was the complete difference.
        const root = await tempRoot();
        await runCommand('open', 'added-task', root, {
            title: 'Added paths',
            acceptance: [{ id: 'AC-1', statement: 'x' }],
            ownedPaths: ['src/owned.ts'],
        });
        await runCommand('design', 'added-task', root);
        const first = await runCommand('build', 'added-task', root, { seal: true, checks: [{ id: 'typecheck', kind: 'typecheck', name: 'typecheck', command: 'true', expectExitCode: 0 }] });
        const base = await readTaskRevision(root, 'added-task', first.diagnostics?.revisionId as string);
        expect(base).toBeTruthy();

        // A new file, committed - so `git status` reports nothing and the base has no digest for it.
        await writeFile(join(root, 'src/added.ts'), 'export const added = 1;\n', 'utf8');
        execFileSync('git', ['add', 'src/added.ts'], { cwd: root });
        execFileSync('git', ['commit', '--quiet', '-m', 'the round added a file and committed'], { cwd: root });

        // The blind call is the defect's shape: the file is invisible, and git says nothing because the round committed.
        const blind = await changeSurfaceAgainstWorkspace(root, base!);
        const blindPaths = blind.status === 'available' ? blind.changedPaths : [];
        expect(blindPaths).not.toContain('src/added.ts');

        // With the current revision supplied the added path appears, and it is the union of its digest *keys* that makes
        // it visible - the revision below carries the base's own digest values unchanged, so only the path set can
        // account for the difference.
        const seen = await changeSurfaceAgainstWorkspace(root, base!, {
            ...base!,
            id: 'revision-current',
            pathDigests: { ...(base!.pathDigests ?? {}), 'src/added.ts': base!.pathDigests?.['src/owned.ts'] ?? 'x' },
        });
        expect(seen.status).toBe('available');
        if (seen.status === 'available') {
            expect(seen.added).toContain('src/added.ts');
        }
    });



    it('refuses to apply a scope change that was never recorded', async () => {
        const root = await tempRoot();
        await runCommand('open', 'scope-missing', root, {
            title: 'Scope applies',
            acceptance: [{ id: 'AC-1', statement: 'x' }],
            ownedPaths: ['src/owned.ts'],
        });

        const { applyScopeChange } = await import('../../src/quality/scope-change.js');
        const applied = await applyScopeChange(root, 'scope-missing', 'scope-99');
        expect(applied.applied).toBe(false);
        expect(applied.reason).toMatch(/no recorded scope change/i);
    });

    it('exposes the CLI subcommand the scope change output tells the operator to run', async () => {
        const root = await tempRoot();
        await runCommand('open', 'scope-cli', root, {
            title: 'Scope CLI',
            acceptance: [{ id: 'AC-1', statement: 'x' }],
            ownedPaths: ['src/owned.ts'],
        });

        const { runScopeCommand } = await import('../../src/cli/scope.js');
        await runScopeCommand(['change', '--change', 'scope-cli', '--add', 'src/outside.ts', '--reason', 'needed'], root);
        const applied = await runScopeCommand(['apply', '--change', 'scope-cli'], root);
        expect(applied.command).toBe('scope apply');
        expect(applied.ownedPaths).toEqual(['src/outside.ts', 'src/owned.ts']);
    });
});
