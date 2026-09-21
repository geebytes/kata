import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { readTask } from '../../src/core/task.js';
import { applyScopeChange, recordScopeChange } from '../../src/quality/scope-change.js';
import { runScopeCommand } from '../../src/cli/scope.js';

/**
 * Applying a scope change must not be able to write a task its own reads refuse.
 *
 * Both defects here were found by an independent adversarial pass, through the **shipped CLI**, and both are the class
 * this change exists to retire: a write path that trusts its input while every read path validates it.
 *
 * 1. `applyScopeChange` wrote `change.scope` straight into `ownedPaths`, and the task schema requires at least one owned
 *    path. A scope change that removed the last one therefore wrote `ownedPaths: []`, after which *every* task-reading
 *    command failed with a schema error — including `scope change --add`, the command that would have added one back. The
 *    task was unrecoverable from the CLI, and `scope apply` cheerfully reported success while changing nothing.
 * 2. Nothing validated the paths' range. An absolute path and `../outside.ts` were written, printed by `scope show` as
 *    `layer: deliverable`, and carried into the design handoff — refused only much later, at seal, by
 *    `normalizeOwnedPaths`. The write is the place to refuse it, in the same terms `validateMatrix` already uses for a
 *    matrix path.
 */
describe('applying a scope change cannot corrupt the task', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function tempRoot(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-scope-safety-'));
        roots.push(root);
        await initLayout(root);
        execFileSync('git', ['init', '--quiet'], { cwd: root });
        execFileSync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
        execFileSync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
        execFileSync('git', ['add', '.'], { cwd: root });
        execFileSync('git', ['commit', '--quiet', '-m', 'base'], { cwd: root });
        return root;
    }

    async function opened(root: string, taskId: string, ownedPaths: string[]): Promise<void> {
        await runCommand('open', taskId, root, {
            title: 'Scope safety',
            acceptance: [{ id: 'AC-1', statement: 'x' }],
            ownedPaths,
        });
    }

    it('refuses to record a scope change that would leave the task with no owned path', async () => {
        const root = await tempRoot();
        await opened(root, 'last-path', ['src/a.ts']);

        const recorded = await recordScopeChange(root, 'last-path', {
            current: ['src/a.ts'],
            next: [],
            reason: 'nothing left to own',
            by: 'kata-agent',
        });
        expect('refused' in recorded).toBe(true);
        if (!('refused' in recorded)) return;
        expect(recorded.refused).toMatch(/at least one owned path/i);
        // And the task is untouched, so every reader still works.
        expect((await readTask(root, 'last-path')).ownedPaths).toEqual(['src/a.ts']);
    });

    it('refuses to apply a recorded scope change that would empty ownedPaths', async () => {
        const root = await tempRoot();
        await opened(root, 'emptied', ['src/a.ts']);
        // Recorded directly: the guard belongs on the write that changes the task, so it must hold even for a record that
        // reached `scope-changes.json` some other way (a hand-edit, or a record written before this rule existed).
        await writeFile(join(root, '.kata/tasks/emptied/scope-changes.json'), `${JSON.stringify({
            changes: [{ id: 'scope-1', at: '2026-09-21T00:00:00.000Z', by: 'x', reason: 'r', added: [], removed: ['src/a.ts'], scope: [] }],
            updatedAt: '2026-09-21T00:00:00.000Z',
        }, null, 2)}\n`, 'utf8');

        const applied = await applyScopeChange(root, 'emptied', 'scope-1');
        expect(applied.applied).toBe(false);
        expect(applied.reason).toMatch(/at least one owned path/i);
        expect((await readTask(root, 'emptied')).ownedPaths).toEqual(['src/a.ts']);
    });

    it('refuses a path that escapes the repository, at the command that was given it', async () => {
        const root = await tempRoot();
        await opened(root, 'escaping', ['src/a.ts']);

        const recorded = await recordScopeChange(root, 'escaping', {
            current: ['src/a.ts'],
            next: ['src/a.ts', '../outside.ts'],
            reason: 'outside the repo',
            by: 'kata-agent',
        });
        expect('refused' in recorded).toBe(true);
        if (!('refused' in recorded)) return;
        expect(recorded.refused).toMatch(/inside the repository/i);
    });

    it('refuses an absolute path in the same terms', async () => {
        const root = await tempRoot();
        await opened(root, 'absolute', ['src/a.ts']);

        const recorded = await recordScopeChange(root, 'absolute', {
            current: ['src/a.ts'],
            next: [join(root, 'src/a.ts'), '/etc/passwd'],
            reason: 'absolute path',
            by: 'kata-agent',
        });
        expect('refused' in recorded).toBe(true);
        if (!('refused' in recorded)) return;
        expect(recorded.refused).toMatch(/inside the repository/i);
    });

    it('refuses to apply a record whose scope carries an escaping path, whichever way it was written', async () => {
        const root = await tempRoot();
        await opened(root, 'escape-apply', ['src/a.ts']);
        await writeFile(join(root, '.kata/tasks/escape-apply/scope-changes.json'), `${JSON.stringify({
            changes: [{ id: 'scope-1', at: '2026-09-21T00:00:00.000Z', by: 'x', reason: 'r', added: ['../outside.ts'], removed: [], scope: ['../outside.ts', 'src/a.ts'] }],
            updatedAt: '2026-09-21T00:00:00.000Z',
        }, null, 2)}\n`, 'utf8');

        const applied = await applyScopeChange(root, 'escape-apply', 'scope-1');
        expect(applied.applied).toBe(false);
        expect(applied.reason).toMatch(/inside the repository/i);
        expect((await readTask(root, 'escape-apply')).ownedPaths).toEqual(['src/a.ts']);
    });

    it('still applies a legitimate change, and normalizes it', async () => {
        const root = await tempRoot();
        await opened(root, 'legit', ['src/a.ts']);
        await mkdir(join(root, 'docs'), { recursive: true });
        await writeFile(join(root, 'docs/note.md'), '# note\n', 'utf8');

        // A `./`-prefixed spelling is the same path, and the stored surface is the normalized one.
        const recorded = await recordScopeChange(root, 'legit', {
            current: ['src/a.ts'],
            next: ['src/a.ts', './docs/note.md'],
            reason: 'the repair needed a doc',
            by: 'kata-agent',
        });
        expect('refused' in recorded).toBe(false);
        if ('refused' in recorded) return;

        const applied = await applyScopeChange(root, 'legit', recorded.id);
        expect(applied.applied).toBe(true);
        expect(applied.ownedPaths).toEqual(['docs/note.md', 'src/a.ts']);
        expect((await readTask(root, 'legit')).ownedPaths).toEqual(['docs/note.md', 'src/a.ts']);
    });

    it('reports the refusal through the CLI, and leaves the task readable', async () => {
        const root = await tempRoot();
        await opened(root, 'cli-refuse', ['src/a.ts']);

        let message = '';
        try {
            await runScopeCommand(['change', '--change', 'cli-refuse', '--remove', 'src/a.ts', '--reason', 'empty it'], root);
        } catch (error) {
            message = error instanceof Error ? error.message : String(error);
        }
        // The removal is refused at the record, so the task never enters the broken state at all.
        expect(message).toMatch(/at least one owned path/i);
        const shown = await runScopeCommand(['show', '--change', 'cli-refuse'], root);
        expect((shown.ownedPaths as Array<{ path: string }>).map((entry) => entry.path)).toEqual(['src/a.ts']);
    });

    it('refuses escaping --owned-path at seal without persisting it', async () => {
        const root = await tempRoot();
        await opened(root, 'seal-escape', ['src/a.ts']);
        await runCommand('design', 'seal-escape', root, {});

        const sealed = await runCommand('build', 'seal-escape', root, {
            seal: true,
            ownedPaths: ['src/a.ts', '../outside.ts', '/etc/passwd'],
        });

        expect(sealed.success).toBe(false);
        expect(String(sealed.error)).toMatch(/inside the repository/i);
        // The refusal must name every offending path and say that nothing was written: the prior behaviour reported
        // one path and left the caller unable to tell a refusal from a partial write.
        expect(String(sealed.error)).toMatch(/\.\.\/outside\.ts/);
        expect(String(sealed.error)).toMatch(/\/etc\/passwd/);
        expect(String(sealed.error)).toMatch(/nothing was written/i);
        expect((await readTask(root, 'seal-escape')).ownedPaths).toEqual(['src/a.ts']);
    });
});
