import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { runCommand } from '../../src/workflow/orchestrator.js';

const execFileAsync = promisify(execFile);

/**
 * The seal check set is inspectable before it runs.
 *
 * Three sources decide it — the project's declaration, discovery from installed documentation (which `kata update`
 * writes, so it can change with no repository change at all), and a fallback — and nothing used to answer "what will
 * this seal run?" until after it had run. `build --list-checks` answers it, with each check's origin, timeout and what
 * it cost last time.
 */
describe('seal check preflight', () => {
    const roots: string[] = [];

    async function tempRoot(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-list-checks-'));
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
            title: 'Preflight fixture',
            acceptance: [{ id: 'AC-1', statement: 'The preflight reports the resolved checks.' }],
        });
        await runCommand('design', taskId, root);
    }

    async function listChecks(root: string, taskId: string, extra: Record<string, unknown> = {}) {
        const result = await runCommand('build', taskId, root, { listChecks: true, ...extra });
        const checks = (result.diagnostics?.checks ?? []) as Array<Record<string, unknown>>;
        return { result, checks };
    }

    it('reports the resolved checks with their origin and timeout, without sealing', async () => {
        const root = await tempRoot();
        await openTask(root, 'preflight-configured');
        await writeFile(join(root, '.kata-config.json'), `${JSON.stringify({
            quality: {
                buildChecks: [
                    { id: 'lint', name: 'lint', kind: 'lint', command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 5_000 },
                ],
            },
        }, null, 2)}\n`, 'utf8');

        const { result, checks } = await listChecks(root, 'preflight-configured');

        expect(result.success).toBe(true);
        expect(checks).toEqual([expect.objectContaining({
            id: 'lint',
            name: 'lint',
            kind: 'lint',
            source: 'configured',
            timeoutMs: 5_000,
            lastDurationMs: null,
            lastExitCode: null,
        })]);
        // Nothing ran: reporting the set recorded no evidence.
        const { readRecordedEvidence } = await import('../../src/quality/evidence.js');
        expect(await readRecordedEvidence(root, 'preflight-configured')).toEqual([]);
    });

    it('labels discovered checks and honours the discovery switch', async () => {
        const root = await tempRoot();
        await openTask(root, 'preflight-discovered');
        await mkdir(join(root, '.agents/skills/quality'), { recursive: true });
        await writeFile(join(root, '.agents/skills/quality/SKILL.md'), [
            '# Quality',
            '',
            '## Acceptance Gate',
            '',
            '```bash',
            'make lint',
            '```',
            '',
        ].join('\n'), 'utf8');

        const discovered = await listChecks(root, 'preflight-discovered');
        expect(discovered.checks).toEqual([expect.objectContaining({ id: 'discovered:lint', source: 'discovered', name: 'lint', timeoutMs: 180_000 })]);

        // The installed documentation is a suggestion the project can refuse: with discovery off and nothing declared,
        // only the fallback set remains, and the report says so.
        const refused = await listChecks(root, 'preflight-discovered', { discoverChecks: false });
        expect(refused.checks.map((check) => check.source)).toEqual(['fallback', 'fallback']);
        expect(refused.checks.map((check) => check.name)).toEqual(['typecheck', 'test']);
    });

    it('shows what each check cost the last time it ran', async () => {
        const root = await tempRoot();
        await openTask(root, 'preflight-durations');
        const check = { id: 'fast', name: 'fast', kind: 'test' as const, command: process.execPath, args: ['-e', 'process.exit(0)'] };

        await runCommand('build', 'preflight-durations', root, { ownedPaths: ['src'], checks: [check] });
        const { checks } = await listChecks(root, 'preflight-durations', { checks: [check] });

        expect(checks).toEqual([expect.objectContaining({ id: 'fast', source: 'explicit', lastExitCode: 0 })]);
        expect(checks[0]!.lastDurationMs).toEqual(expect.any(Number));
    });

    it('stamps the resolved check identity onto the recorded evidence', async () => {
        const root = await tempRoot();
        await openTask(root, 'preflight-evidence');

        await runCommand('build', 'preflight-evidence', root, {
            ownedPaths: ['src'],
            checks: [{ id: 'declared-check', name: 'declared', kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'] }],
        });

        const { readRecordedEvidence } = await import('../../src/quality/evidence.js');
        const evidence = await readRecordedEvidence(root, 'preflight-evidence');
        expect(evidence).toEqual([expect.objectContaining({ checkId: 'declared-check', checkSource: 'explicit' })]);
    });
});
