import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { runCommand } from '../../src/workflow/orchestrator.js';

const execFileAsync = promisify(execFile);

/**
 * The bounded repair loop, end to end: while a repair is active, sealing may not carry changes outside the
 * acceptance criteria that repair was authorized for.
 */
describe('bounded repair scope', () => {
    const roots: string[] = [];

    async function tempRoot(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-repair-scope-'));
        roots.push(root);
        await execFileAsync('git', ['init', '-q'], { cwd: root });
        await execFileAsync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
        await execFileAsync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });
        await initLayout(root);
        await mkdir(join(root, 'src'), { recursive: true });
        await mkdir(join(root, 'tests'), { recursive: true });
        await writeFile(join(root, 'src/foo.ts'), 'export const value = 1;\n', 'utf8');
        await writeFile(join(root, 'tests/foo.test.ts'), 'export const covered = true;\n', 'utf8');
        await writeFile(join(root, 'unrelated.md'), 'baseline\n', 'utf8');
        await execFileAsync('git', ['add', '-A'], { cwd: root });
        await execFileAsync('git', ['commit', '-qm', 'baseline'], { cwd: root });
        return root;
    }

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function openRepairTask(root: string, taskId: string): Promise<void> {
        await runCommand('open', taskId, root, {
            title: 'Repair scope fixture',
            acceptance: [{ id: 'AC-1', statement: 'The change is covered by a focused test.' }],
        });
        const taskPath = join(root, '.kata/tasks', taskId, 'task.json');
        const task = JSON.parse(await readFile(taskPath, 'utf8')) as Record<string, unknown>;
        task.ownedPaths = ['src', 'tests', 'unrelated.md'];
        task.acceptanceMatrix = {
            version: 1,
            rows: [
                {
                    acceptanceId: 'AC-1',
                    implementationPaths: ['src/foo.ts'],
                    testPaths: ['tests/foo.test.ts'],
                    evidence: [{ kind: 'test', command: process.execPath }],
                    verificationLevel: 'unit',
                },
            ],
        };
        await writeFile(taskPath, `${JSON.stringify(task, null, 2)}\n`, 'utf8');
        await runCommand('design', taskId, root);
    }

    async function authorizeRepair(root: string, taskId: string): Promise<void> {
        await writeFile(
            join(root, '.kata/tasks', taskId, 'repair.json'),
            `${JSON.stringify({
                taskId,
                fromPhase: 'hardVerify',
                toPhase: 'implement',
                reason: 'verify_fail',
                scopes: [{ id: 'AC-1', repairScope: 'missing_test_evidence' }],
                createdAt: '2026-09-17T00:00:00.000Z',
            }, null, 2)}\n`,
            'utf8',
        );
    }

    const seal = (taskId: string, root: string, extra: Record<string, unknown> = {}) => runCommand('build', taskId, root, {
        ownedPaths: ['src', 'tests', 'unrelated.md'],
        checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
        ...extra,
    });

    it('blocks a repair that reaches outside the failed acceptance scope', async () => {
        const root = await tempRoot();
        await openRepairTask(root, 'repair-out-of-scope');
        await authorizeRepair(root, 'repair-out-of-scope');
        await writeFile(join(root, 'src/foo.ts'), 'export const value = 2;\n', 'utf8');
        await writeFile(join(root, 'unrelated.md'), 'touched by the repair\n', 'utf8');

        const result = await seal('repair-out-of-scope', root);

        expect(result.success).toBe(false);
        expect(result.error).toContain('outside the failed acceptance scope');
        expect(result.diagnostics?.unrelatedRepairPaths).toEqual(['unrelated.md']);
        expect(result.diagnostics?.repairScopePaths).toEqual(['src/foo.ts', 'tests/foo.test.ts']);
    });

    it('seals the same repair when the caller acknowledges the wider diff', async () => {
        const root = await tempRoot();
        await openRepairTask(root, 'repair-acknowledged');
        await authorizeRepair(root, 'repair-acknowledged');
        await writeFile(join(root, 'src/foo.ts'), 'export const value = 2;\n', 'utf8');
        await writeFile(join(root, 'unrelated.md'), 'touched by the repair\n', 'utf8');

        const result = await seal('repair-acknowledged', root, { allowOutOfScopeRepair: true });

        expect(result.error ?? '').not.toContain('outside the failed acceptance scope');
    });

    it('does not constrain a repair that stays inside its scope', async () => {
        const root = await tempRoot();
        await openRepairTask(root, 'repair-in-scope');
        await authorizeRepair(root, 'repair-in-scope');
        await writeFile(join(root, 'src/foo.ts'), 'export const value = 2;\n', 'utf8');
        await writeFile(join(root, 'tests/foo.test.ts'), 'export const covered = false;\n', 'utf8');

        const result = await seal('repair-in-scope', root);

        expect(result.error ?? '').not.toContain('outside the failed acceptance scope');
        expect(result.success).toBe(true);
        expect(result.phase).toBe('hardVerify');
    });

    it('leaves a drift-authorized repair unconstrained, because it records no acceptance scope', async () => {
        const root = await tempRoot();
        await openRepairTask(root, 'repair-drift');
        await writeFile(
            join(root, '.kata/tasks/repair-drift/repair.json'),
            `${JSON.stringify({
                taskId: 'repair-drift',
                fromPhase: 'judge',
                toPhase: 'implement',
                reason: 'revision_superseded',
                scopes: [],
                createdAt: '2026-09-17T00:00:00.000Z',
            }, null, 2)}\n`,
            'utf8',
        );
        await writeFile(join(root, 'src/foo.ts'), 'export const value = 3;\n', 'utf8');
        await writeFile(join(root, 'unrelated.md'), 'touched after judge\n', 'utf8');

        const result = await seal('repair-drift', root);

        expect(result.error ?? '').not.toContain('outside the failed acceptance scope');
        expect(result.success).toBe(true);
    });
});
