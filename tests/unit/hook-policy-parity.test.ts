import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { renderHookGuardScript } from '../../src/adapters/ownership.js';
import { validateWrite, type Actor } from '../../src/policy/permissions.js';
import type { TaskRecord } from '../../src/core/task.js';

const execFileAsync = promisify(execFile);
const taskId = 'parity-task';

/**
 * The emitted hook guard embeds the policy source, so the guard a developer runs and the in-process check must agree
 * on every case. This test executes the generated script and compares it with `validateWrite` case by case; if the two
 * ever drift, one of them is wrong and this fails.
 */
describe('hook guard and in-process policy parity', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    const cases: Array<{ role: string; phase: string; path: string }> = [
        { role: 'implementer', phase: 'implement', path: 'src/core/state.ts' },
        { role: 'implementer', phase: 'implement', path: 'tests/unit/state.test.ts' },
        { role: 'implementer', phase: 'implement', path: 'docs/audit/note.md' },
        { role: 'implementer', phase: 'implement', path: 'README.md' },
        { role: 'implementer', phase: 'intake', path: 'src/core/state.ts' },
        { role: 'implementer', phase: 'plan', path: 'tests/unit/state.test.ts' },
        { role: 'implementer', phase: 'archive', path: 'src/core/state.ts' },
        { role: 'implementer', phase: 'implement', path: 'docs/superpowers/rules/verified.md' },
        { role: 'reviewer', phase: 'review', path: `.kata/tasks/${taskId}/review.json` },
        { role: 'reviewer', phase: 'review', path: 'src/core/state.ts' },
        { role: 'judge', phase: 'judge', path: `.kata/tasks/${taskId}/judge.json` },
        { role: 'judge', phase: 'judge', path: `.kata/tasks/${taskId}/review.json` },
        { role: 'distiller', phase: 'distill', path: '.kata/wiki/candidates/a.json' },
        { role: 'distiller', phase: 'distill', path: '.kata/wiki/verified/a.json' },
        { role: 'approver', phase: 'distill', path: '.kata/wiki/verified/a.json' },
        { role: 'implementer', phase: 'implement', path: '../outside.ts' },
        { role: 'implementer', phase: 'implement', path: 'docs/../src/core/state.ts' },
        { role: 'implementer', phase: 'implement', path: 'C:/windows/path.ts' },
        { role: 'unknown-role', phase: 'implement', path: 'src/core/state.ts' },
        { role: 'implementer', phase: 'implement', path: '/tmp/outside-kata.ts' },
    ];

    async function prepare(root: string, phase: string, role: string): Promise<string> {
        await mkdir(join(root, '.kata/tasks', taskId), { recursive: true });
        await mkdir(join(root, '.kata/runtime'), { recursive: true });
        await writeFile(join(root, '.kata/tasks', taskId, 'current-state.json'), `${JSON.stringify({ taskId, phase, actor: { id: 'a', role }, updatedAt: '2026-09-17T00:00:00.000Z' })}\n`, 'utf8');
        await writeFile(join(root, '.kata/tasks', taskId, 'task.json'), `${JSON.stringify({ id: taskId, title: 'Parity', phase, acceptance: [] })}\n`, 'utf8');
        await writeFile(join(root, '.kata/runtime/active-task.json'), `${JSON.stringify({ taskId, role, phase, activatedAt: '2026-09-17T00:00:00.000Z' })}\n`, 'utf8');
        const scriptPath = join(root, 'kata-hook-guard.mjs');
        await writeFile(scriptPath, renderHookGuardScript(), 'utf8');
        return scriptPath;
    }

    async function runHook(script: string, root: string, filePath: string): Promise<{ exitCode: number; stderr: string }> {
        const child = execFileAsync(process.execPath, [script, '--project-root', root], { cwd: root });
        child.child.stdin?.end(JSON.stringify({ tool_input: { file_path: filePath } }));
        try {
            const { stderr } = await child;
            return { exitCode: 0, stderr };
        } catch (error) {
            const failure = error as { code?: number; stderr?: string };
            return { exitCode: typeof failure.code === 'number' ? failure.code : 1, stderr: failure.stderr ?? '' };
        }
    }

    it('agrees with validateWrite on every case', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-hook-parity-'));
        roots.push(root);
        let script = '';

        for (const testCase of cases) {
            script = await prepare(root, testCase.phase, testCase.role);
            const task: TaskRecord = {
                id: taskId,
                title: 'Parity',
                phase: testCase.phase as TaskRecord['phase'],
                acceptance: [],
                createdAt: '2026-09-17T00:00:00.000Z',
                updatedAt: '2026-09-17T00:00:00.000Z',
            };
            const typed = validateWrite({ id: 'agent', role: testCase.role }, testCase.path, task, root);
            const hook = await runHook(script, root, testCase.path);

            expect(
                { case: testCase, hookExit: hook.exitCode === 2 ? 'denied' : hook.exitCode === 0 ? 'allowed' : `exit-${hook.exitCode}` },
            ).toEqual({
                case: testCase,
                hookExit: typed.allowed ? 'allowed' : 'denied',
            });

            if (!typed.allowed) {
                expect({ case: testCase, typed: typed.reason, hook: hook.stderr }).toMatchObject({
                    case: testCase,
                    typed: typed.reason,
                    hook: expect.stringContaining(typed.reason),
                });
            }
        }
    }, 120_000);
});
