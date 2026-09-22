import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { findOwnershipConflicts } from '../../src/workflow/revision.js';

import { createExecutionSandbox } from '../../src/workflow/execution-sandbox.js';
const execFileAsync = promisify(execFile);

/**
 * What a seal costs, and what identifies it.
 *
 * Independent checks used to run one at a time, every seal re-ran them all unconditionally, the previous evidence was
 * deleted rather than kept, and a byte-identical re-seal minted a new revision id — which silently invalidated any
 * review or judge verdict bound to the previous one even though nothing had changed.
 */
describe('seal cost and revision identity', () => {
    const roots: string[] = [];

    async function tempRoot(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-seal-cost-'));
        roots.push(root);
        await execFileAsync('git', ['init', '-q'], { cwd: root });
        await execFileAsync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
        await execFileAsync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });
        await initLayout(root);
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src/foo.ts'), 'export const value = 1;\n', 'utf8');
        await execFileAsync('git', ['add', '-A'], { cwd: root });
        await execFileAsync('git', ['commit', '-qm', 'baseline'], { cwd: root });
        return root;
    }

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function openTask(root: string, taskId: string): Promise<void> {
        await runCommand('open', taskId, root, {
            title: 'Seal cost fixture',
            acceptance: [{ id: 'AC-1', statement: 'The seal is cheap when nothing changed.' }],
        });
        await runCommand('design', taskId, root);
    }

    const seal = (taskId: string, root: string, extra: Record<string, unknown> = {}) => runCommand('build', taskId, root, {
        ownedPaths: ['src'],
        ...extra,
    });

    it('runs checks concurrently only when the project opts in', async () => {
        const root = await tempRoot();
        await openTask(root, 'concurrent-checks');
        // Serial by default: checks may share state the seal cannot see (a database, a port, a cache), so overlapping
        // them is the project's decision.
        const previousConcurrency = process.env.KATA_CHECK_CONCURRENCY;
        process.env.KATA_CHECK_CONCURRENCY = '2';
        try {
        // 'first' cannot finish until 'second' has started. Serial execution would time it out; concurrent execution
        // lets them hand off through the filesystem.
        const witness = join(root, 'second-started');
        const result = await seal('concurrent-checks', root, {
            checks: [
                {
                    id: 'first', name: 'first', kind: 'test', command: process.execPath, cwd: root, timeoutMs: 10_000,
                    args: ['-e', `const fs=require('fs');const file='${witness}';const until=Date.now()+8000;const tick=()=>{if(fs.existsSync(file))process.exit(0);if(Date.now()>until)process.exit(3);setTimeout(tick,20)};tick();`],
                },
                {
                    id: 'second', name: 'second', kind: 'test', command: process.execPath, cwd: root, timeoutMs: 10_000,
                    args: ['-e', `require('fs').writeFileSync('${witness}','yes')`],
                },
            ],
        });

            expect(result).toMatchObject({ success: true });
        } finally {
            if (previousConcurrency === undefined) delete process.env.KATA_CHECK_CONCURRENCY;
            else process.env.KATA_CHECK_CONCURRENCY = previousConcurrency;
        }
    });

    it('runs checks one at a time by default', async () => {
        const root = await tempRoot();
        await openTask(root, 'serial-checks');
        // 'second' writes a witness file; 'first' records whether it was already there when it started. Serial execution
        // must never see it.
        const witness = join(root, 'second-ran');
        const result = await seal('serial-checks', root, {
            checks: [
                {
                    id: 'first', name: 'first', kind: 'test', command: process.execPath, cwd: root, timeoutMs: 10_000,
                    args: ['-e', `process.exit(require('fs').existsSync('${witness}') ? 3 : 0)`],
                },
                {
                    id: 'second', name: 'second', kind: 'test', command: process.execPath, cwd: root, timeoutMs: 10_000,
                    args: ['-e', `require('fs').writeFileSync('${witness}','yes')`],
                },
            ],
        });

        expect(result).toMatchObject({ success: true });
        // A sequential check sees no witness; its success is the observation, without writing back into the author tree.
    });

    it('runs checks in an isolated execution snapshot and reuses the unchanged author revision', async () => {
        const root = await tempRoot();
        await openTask(root, 'reuse-seal');
        const marker = join(root, 'check-ran.txt');
        const checks = [{
            id: 'marker', name: 'marker', kind: 'test' as const, command: process.execPath, cwd: root,
            args: ['-e', "require('fs').appendFileSync('check-ran.txt','ran\\n')"],
        }];

        const first = await seal('reuse-seal', root, { checks });
        await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        expect(first).toMatchObject({ success: true });
        const firstRevision = (first.diagnostics as { revision?: string })?.revision;
        const second = await seal('reuse-seal', root, { checks });

        // The check did not run a second time: the reused revision already proved this content.
        expect(second).toMatchObject({ success: true });
        expect(second.diagnostics).toMatchObject({ reusedEvidence: 1 });
        expect((second.diagnostics as { reusedRevision?: string })?.reusedRevision).toBeDefined();
        await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        void firstRevision;
    });

    it('copies runtime dependencies resolved from an ancestor workspace into the sandbox', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'kata-runtime-workspace-'));
        roots.push(workspace);
        const root = join(workspace, 'checkout');
        await mkdir(join(workspace, 'node_modules', 'fixture-runtime'), { recursive: true });
        await mkdir(join(root, 'src'), { recursive: true });
        await mkdir(join(workspace, 'node_modules', '.bin'), { recursive: true });
        await symlink('../fixture-runtime/index.js', join(workspace, 'node_modules', '.bin', 'fixture-runtime'));
        await writeFile(join(workspace, 'node_modules', 'fixture-runtime', 'index.js'), 'module.exports = 1;\n', 'utf8');
        await writeFile(join(root, 'package.json'), '{"name":"fixture"}\n', 'utf8');
        await writeFile(join(root, 'src', 'subject.js'), 'export const value = 1;\n', 'utf8');
        await execFileAsync('git', ['init', '-q'], { cwd: root });
        await execFileAsync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
        await execFileAsync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });
        await execFileAsync('git', ['add', '-A'], { cwd: root });
        await execFileAsync('git', ['commit', '-qm', 'baseline'], { cwd: root });

        const sandbox = await createExecutionSandbox(root);
        try {
            const copied = join(sandbox.root, 'node_modules', 'fixture-runtime', 'index.js');
            await expect(readFile(copied, 'utf8')).resolves.toBe('module.exports = 1;\n');
            expect((await lstat(join(sandbox.root, 'node_modules', 'fixture-runtime'))).isSymbolicLink()).toBe(false);
            const bin = join(sandbox.root, 'node_modules', '.bin', 'fixture-runtime');
            await expect(readFile(bin, 'utf8')).resolves.toBe('module.exports = 1;\n');
            expect((await lstat(bin)).isSymbolicLink()).toBe(true);
        } finally {
            await sandbox.dispose();
        }
    });

    it('refuses a runtime dependency symlink that escapes the sandbox', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'kata-runtime-escape-'));
        roots.push(workspace);
        const root = join(workspace, 'checkout');
        await mkdir(join(workspace, 'node_modules', '.bin'), { recursive: true });
        await mkdir(join(root, 'src'), { recursive: true });
        await symlink('../../author-escape', join(workspace, 'node_modules', '.bin', 'escape'));
        await writeFile(join(root, 'package.json'), '{"name":"fixture"}\n', 'utf8');
        await writeFile(join(root, 'src', 'subject.js'), 'export const value = 1;\n', 'utf8');
        await execFileAsync('git', ['init', '-q'], { cwd: root });
        await execFileAsync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
        await execFileAsync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });
        await execFileAsync('git', ['add', '-A'], { cwd: root });
        await execFileAsync('git', ['commit', '-qm', 'baseline'], { cwd: root });

        await expect(createExecutionSandbox(root)).rejects.toThrow('Refusing runtime dependency symlink outside the execution sandbox');
    });

    it('mints a new revision only when the content changes', async () => {
        const root = await tempRoot();
        await openTask(root, 'revision-identity');
        const checks = [{ id: 'noop', name: 'noop', kind: 'test' as const, command: process.execPath, cwd: root, args: ['-e', 'process.exit(0)'] }];

        const first = await seal('revision-identity', root, { checks });
        const revisionPath = join(root, '.kata/tasks/revision-identity/current-revision.json');
        const firstId = (JSON.parse(await readFile(revisionPath, 'utf8')) as { id: string }).id;
        expect(firstId).toMatch(/^revision-[0-9a-f]{16}$/);

        await seal('revision-identity', root, { checks });
        expect((JSON.parse(await readFile(revisionPath, 'utf8')) as { id: string }).id).toBe(firstId);

        await writeFile(join(root, 'src/foo.ts'), 'export const value = 2;\n', 'utf8');
        await seal('revision-identity', root, { checks });
        const changedId = (JSON.parse(await readFile(revisionPath, 'utf8')) as { id: string }).id;
        expect(changedId).not.toBe(firstId);
        expect(first).toMatchObject({ success: true });
    });

    it('archives the previous evidence under the revision it belonged to', async () => {
        const root = await tempRoot();
        await openTask(root, 'evidence-archive');
        const checks = [{ id: 'noop', name: 'noop', kind: 'test' as const, command: process.execPath, cwd: root, args: ['-e', 'process.exit(0)'] }];

        await seal('evidence-archive', root, { checks });
        const firstRevision = (JSON.parse(await readFile(join(root, '.kata/tasks/evidence-archive/current-revision.json'), 'utf8')) as { id: string }).id;
        await writeFile(join(root, 'src/foo.ts'), 'export const value = 2;\n', 'utf8');
        await seal('evidence-archive', root, { checks });

        // The active set is the current seal's; the superseded revision's evidence is still readable.
        const archived = await readdir(join(root, '.kata/evidence/superseded', firstRevision));
        expect(archived).toEqual([expect.stringContaining('evidence-archive-')]);
        const active = (await readdir(join(root, '.kata/evidence'))).filter((file) => file.startsWith('evidence-archive-'));
        expect(active).toHaveLength(1);
    });

    it('reports ownership conflicts at the files both tasks own', async () => {
        const root = await tempRoot();
        await mkdir(join(root, 'shared'), { recursive: true });
        await writeFile(join(root, 'shared/mine.ts'), 'export const mine = 1;\n', 'utf8');
        await writeFile(join(root, 'shared/theirs.ts'), 'export const theirs = 1;\n', 'utf8');
        for (const taskId of ['mine-task', 'theirs-task']) {
            await mkdir(join(root, '.kata/tasks', taskId), { recursive: true });
            await writeFile(join(root, '.kata/tasks', taskId, 'task.json'), `${JSON.stringify({
                id: taskId, title: taskId, phase: 'implement',
                acceptance: [{ id: 'AC-1', statement: 'x' }],
                createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
                ownedPaths: [taskId === 'mine-task' ? 'shared/mine.ts' : 'shared/theirs.ts'],
            })}\n`, 'utf8');
        }

        // Different files in the same directory are not a conflict…
        expect(await findOwnershipConflicts(root, 'mine-task', ['shared/mine.ts'])).toEqual([]);

        // …while the same file is, and the conflict names it.
        await writeFile(join(root, '.kata/tasks/theirs-task/task.json'), `${JSON.stringify({
            id: 'theirs-task', title: 'theirs-task', phase: 'implement',
            acceptance: [{ id: 'AC-1', statement: 'x' }],
            createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
            ownedPaths: ['shared/mine.ts'],
        })}\n`, 'utf8');
        expect(await findOwnershipConflicts(root, 'mine-task', ['shared/mine.ts'])).toEqual([{ taskId: 'theirs-task', path: 'shared/mine.ts' }]);

        // A claim on the whole directory legitimately collides with a sibling's file claim, and names the file.
        expect(await findOwnershipConflicts(root, 'mine-task', ['shared'])).toEqual([{ taskId: 'theirs-task', path: 'shared/mine.ts' }]);
    });

    it('writes a readable heartbeat while the seal runs', async () => {
        const root = await tempRoot();
        await openTask(root, 'heartbeat-seal');
        const result = await seal('heartbeat-seal', root, {
            checks: [
                { id: 'linty', name: 'linty', kind: 'lint', command: process.execPath, cwd: root, timeoutMs: 10_000, args: ['-e', 'process.exit(0)'] },
                { id: 'testy', name: 'testy', kind: 'test', command: process.execPath, cwd: root, timeoutMs: 10_000, args: ['-e', 'process.exit(0)'] },
            ],
        });

        expect(result).toMatchObject({ success: true });
        // Monitoring a seal used to mean pgrep-ing for a process (which false-positives on the agent's own command
        // line) or waiting blind; the seal now says what it is doing, when, and for how long.
        const lines = (await readFile(join(root, '.kata/tasks/heartbeat-seal/seal-progress.jsonl'), 'utf8'))
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>);

        const states = lines.filter((line) => line.type === 'quality_check_progress');
        expect(states.some((line) => line.check === 'linty' && line.state === 'started')).toBe(true);
        expect(states.some((line) => line.check === 'testy' && line.state === 'passed')).toBe(true);
        expect(states.every((line) => typeof line.at === 'string')).toBe(true);
        expect(lines.at(-1)).toMatchObject({ type: 'seal_complete', checks: 2 });
    });

});
