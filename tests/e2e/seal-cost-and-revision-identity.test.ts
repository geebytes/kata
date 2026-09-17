import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { findOwnershipConflicts } from '../../src/workflow/revision.js';

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
                    args: ['-e', `const fs=require('fs');fs.writeFileSync('${join(root, 'first-saw')}',String(fs.existsSync('${witness}')));`],
                },
                {
                    id: 'second', name: 'second', kind: 'test', command: process.execPath, cwd: root, timeoutMs: 10_000,
                    args: ['-e', `require('fs').writeFileSync('${witness}','yes')`],
                },
            ],
        });

        expect(result).toMatchObject({ success: true });
        expect(await readFile(join(root, 'first-saw'), 'utf8')).toBe('false');
    });

    it('reuses an unchanged revision and its evidence instead of re-running the checks', async () => {
        const root = await tempRoot();
        await openTask(root, 'reuse-seal');
        const marker = join(root, 'check-ran.txt');
        const checks = [{
            id: 'marker', name: 'marker', kind: 'test' as const, command: process.execPath, cwd: root,
            args: ['-e', `require('fs').appendFileSync('${marker}','ran\\n')`],
        }];

        const first = await seal('reuse-seal', root, { checks });
        expect(first).toMatchObject({ success: true });
        const firstRevision = (first.diagnostics as { revision?: string })?.revision;
        const second = await seal('reuse-seal', root, { checks });

        // The check did not run a second time: the reused revision already proved this content.
        expect(second).toMatchObject({ success: true });
        expect(second.diagnostics).toMatchObject({ reusedEvidence: 1 });
        expect((second.diagnostics as { reusedRevision?: string })?.reusedRevision).toBeDefined();
        expect((await readFile(marker, 'utf8')).trim().split('\n')).toEqual(['ran']);
        void firstRevision;
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
});
