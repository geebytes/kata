import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { readObligations } from '../../src/quality/repair-obligations.js';

const execFileAsync = promisify(execFile);

/**
 * An unresolved obligation must not block the run that would resolve it.
 *
 * `collectSealPreflight` denies a seal while an obligation lacks a `resolvedAt`, and it runs before the checks.
 * `resolveObligationsForRevision` — the only path that ever sets one — runs after them. So on a task whose obligation the
 * run's own checks would answer, the seal refused to let the run produce that evidence.
 *
 * This is the shape no existing test exercised: both obligation tests in `tests/e2e/quality-gates.test.ts` call the
 * resolver directly, so nothing ever sealed a task carrying an unresolved obligation and asserted the seal resolved it.
 * The deadlock was also masked by check 5's `if (task.acceptanceMatrix) return;`, which is gone.
 */
describe('an unresolved obligation and the run that answers it', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function tempRoot(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-obligation-deadlock-'));
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

    /**
     * A single passing check, declared as the project's whole suite.
     *
     * `discoverChecks: false` keeps the fixture self-contained: the fallback TypeScript/Vitest checks are skipped, so the
     * run's evidence is exactly this check's, which is what the obligation is answered with.
     */
    async function declaredPassingCheck(root: string): Promise<void> {
        await writeFile(join(root, '.kata-config.json'), `${JSON.stringify({
            quality: {
                discoverChecks: false,
                buildChecks: [{
                    id: 'obligation-check', name: 'obligation-check', kind: 'test',
                    command: process.execPath, args: ['-e', 'process.exit(0)'],
                    timeoutMs: 30_000,
                }],
            },
        }, null, 2)}\n`, 'utf8');
    }

    async function taskWith(root: string, taskId: string, obligation: Record<string, unknown>): Promise<void> {
        await runCommand('open', taskId, root, {
            title: 'Deadlock fixture',
            acceptance: [{ id: 'AC-1', statement: 'The obligation is answered by the run.' }],
        });
        await runCommand('design', taskId, root);
        await writeFile(join(root, '.kata/tasks', taskId, 'repair-obligations.json'), `${JSON.stringify({
            updatedAt: '2026-09-20T00:00:00.000Z',
            obligations: [{ id: 'obligation-1', taskId, source: 'review', createdAt: '2026-09-20T00:00:00.000Z', ...obligation }],
        }, null, 2)}\n`, 'utf8');
    }

    it('seals a matrix-less task whose obligation this run answers, and resolves it', async () => {
        const root = await tempRoot();
        const taskId = 'resolvable-obligation';
        await declaredPassingCheck(root);
        // Unscoped, which is the shape an adversarial finding raises — the one that could never resolve.
        await taskWith(root, taskId, { severity: 'major', message: 'A major finding owes a repair.' });

        const result = await runCommand('build', taskId, root, { seal: true, ownedPaths: ['src'] });

        expect(result.error ?? '').not.toContain('Unresolved repair obligations');
        const [obligation] = await readObligations(root, taskId);
        expect(obligation!.resolvedAt).toBeDefined();
        expect(obligation!.resolvedEvidenceIds?.length).toBeGreaterThan(0);
    });

    it('still refuses an obligation this run cannot answer, and says which case it is', async () => {
        const root = await tempRoot();
        const taskId = 'unanswerable-obligation';
        await declaredPassingCheck(root);
        // Scoped to a criterion the run's evidence will not satisfy: no check is bound to AC-9, and there is no matrix.
        await taskWith(root, taskId, { severity: 'blocking', acceptanceId: 'AC-9', message: 'A criterion nothing proves.' });

        const result = await runCommand('build', taskId, root, { seal: true, ownedPaths: ['src'] });

        expect(result.success).toBe(false);
        expect(result.error).toContain('Unresolved repair obligations');
        expect(result.error).toContain('AC-9');
        const [obligation] = await readObligations(root, taskId);
        expect(obligation!.resolvedAt).toBeUndefined();
    });

});
