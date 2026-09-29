import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { runCommand } from '../../src/workflow/orchestrator.js';

const execFileAsync = promisify(execFile);

/**
 * The seal preflight reports every blocker it finds, not just the first.
 *
 * The preflight was nine sequential early returns, so a task with three independent closure problems was told about one
 * per run — and every run of the repair loop paid the whole evidence cost again before reaching the next one. The
 * collection keeps each blocker's original message and diagnostics key, so the first one is exactly what the early
 * return produced, and the rest follow in the order the old code would have hit them.
 */
describe('seal preflight blockers', () => {
    const roots: string[] = [];
    let previousCodeGraphBin: string | undefined;

    afterEach(async () => {
        if (previousCodeGraphBin === undefined) delete process.env.STRATA_CODEGRAPH_BIN;
        else process.env.STRATA_CODEGRAPH_BIN = previousCodeGraphBin;
        previousCodeGraphBin = undefined;
    });

    /** Strict closure asks CodeGraph which tests are affected; a fake that reports none keeps the test self-contained. */
    async function stubCodeGraph(root: string): Promise<void> {
        // Under `tmp/`, which this project's rules reserve for working files — and which the seal does not treat as part
        // of the change surface. Written at the repository root it became an undeclared change, which is exactly the state
        // the preflight now refuses.
        await mkdir(join(root, 'tmp'), { recursive: true });
        const binary = join(root, 'tmp', 'fake-codegraph');
        await writeFile(binary, '#!/bin/sh\nprintf "No affected test files found.\n"\n', 'utf8');
        await chmod(binary, 0o755);
        previousCodeGraphBin = process.env.STRATA_CODEGRAPH_BIN;
        process.env.STRATA_CODEGRAPH_BIN = binary;
    }

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function tempRoot(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-seal-preflight-'));
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

    async function openStrictTask(root: string, taskId: string, options: { ownedPaths?: string[]; matrix?: unknown } = {}): Promise<void> {
        await runCommand('open', taskId, root, {
            title: 'Preflight fixture',
            acceptance: [{ id: 'AC-1', statement: 'The seal reports every blocker.' }],
        });
        await runCommand('design', taskId, root);
        const taskPath = join(root, '.kata/tasks', taskId, 'task.json');
        const task = JSON.parse(await readFile(taskPath, 'utf8')) as Record<string, unknown>;
        const profile = (task.workflowProfile ?? {}) as Record<string, unknown>;
        task.workflowProfile = { ...profile, strictClosure: true };
        if (options.ownedPaths) task.ownedPaths = options.ownedPaths;
        if (options.matrix) task.acceptanceMatrix = options.matrix;
        await writeFile(taskPath, `${JSON.stringify(task, null, 2)}\n`, 'utf8');
    }

    function blockersOf(result: { diagnostics?: Record<string, unknown> }): Array<{ code: string; message: string }> {
        return (result.diagnostics?.blockers ?? []) as Array<{ code: string; message: string }>;
    }

    it('reports independent blockers together, keeping the first one’s shape', async () => {
        const root = await tempRoot();
        await stubCodeGraph(root);
        const taskId = 'preflight-multi';
        // Two independent problems: upstream coverage is required but absent, and the matrix declares a test path the
        // owned paths do not cover.
        await openStrictTask(root, taskId, {
            ownedPaths: ['src'],
            matrix: {
                version: 1,
                rows: [{
                    acceptanceId: 'AC-1',
                    implementationPaths: ['src/foo.ts'],
                    testPaths: ['tests/not-owned.test.ts'],
                    evidence: [{ kind: 'test', command: 'vitest' }],
                    verificationLevel: 'unit',
                }],
            },
        });

        const result = await runCommand('build', taskId, root, { seal: true });
        const blockers = blockersOf(result);

        expect(result).toMatchObject({ success: false, phase: 'implement' });
        expect(blockers.map((blocker) => blocker.code)).toEqual(['missingUpstreamCoverage', 'pathCoverage']);
        expect(result.diagnostics).toMatchObject({
            // The first blocker keeps the diagnostics key its early return used…
            missingUpstreamCoverage: true,
            blockerCount: 2,
        });
        // …and every blocker carries its own diagnostics, so a caller can act on all of them.
        expect((blockers[1]!.message)).toContain('Owned path coverage incomplete');
        const pathCoverageDiagnostics = (result.diagnostics?.blockers as Array<{ diagnostics: Record<string, unknown> }>)[1]!.diagnostics;
        expect(pathCoverageDiagnostics).toMatchObject({ missingTestPaths: ['tests/not-owned.test.ts'] });
        // The error text names the count, so a human reading it knows this is not the whole story.
        expect(result.error).toContain('blocked by 2 independent problems');
    });

    it('refuses on a single blocker, and the obligation blocker is gone with the store it read', async () => {
        // This case used to seed `repair-obligations.json` and assert that the preflight refused the seal for it. Nothing
        // creates an obligation for a governed change any more — a judge FAIL is carried by the ledger, the review approval
        // that judge requires refuses changes without one, and the round route that recorded findings is deleted — so the
        // step that read the store is deleted and the case goes with it. What remains is the property it was standing next
        // to: a single blocker is still reported with its own diagnostics rather than swallowed by the first one found.
        const root = await tempRoot();
        const taskId = 'preflight-single';
        await runCommand('open', taskId, root, {
            title: 'Preflight fixture',
            acceptance: [{ id: 'AC-1', statement: 'The seal reports its blocker.' }],
        });
        await runCommand('design', taskId, root);

        const result = await runCommand('build', taskId, root, { seal: true, ownedPaths: ['src'] });

        expect(result.success).toBe(false);
        expect(result.diagnostics?.revisionId).toBeUndefined();
        // Whatever blocks it, the refusal is a refusal rather than a sealed revision with nothing said.
        expect(String(result.error ?? '')).not.toHaveLength(0);
    });

    it('reports a consequence alongside its cause rather than one at a time', async () => {
        const root = await tempRoot();
        const taskId = 'preflight-consequences';
        // A matrix path outside the repository is the cause; the upstream-coverage and path-coverage checks that read
        // those paths report alongside it, instead of the next run discovering them one by one.
        await openStrictTask(root, taskId, {
            ownedPaths: ['src'],
            matrix: {
                version: 1,
                rows: [{
                    acceptanceId: 'AC-1',
                    implementationPaths: ['../outside.ts'],
                    testPaths: ['src/foo.ts'],
                    evidence: [{ kind: 'test', command: 'vitest' }],
                    verificationLevel: 'unit',
                }],
            },
        });

        const result = await runCommand('build', taskId, root, { seal: true });

        expect(result.success).toBe(false);
        expect(blockersOf(result).map((blocker) => blocker.code)).toEqual(expect.arrayContaining(['matrixErrors', 'pathCoverage']));
        expect(result.error).toContain('Acceptance matrix validation failed');
        expect(result.error).toContain('blocked by');
    });

    it('collects the path blockers even when owned paths could not be resolved', async () => {
        const root = await tempRoot();
        const taskId = 'preflight-no-owned-paths';
        await openStrictTask(root, taskId, {
            matrix: {
                version: 1,
                rows: [{
                    acceptanceId: 'AC-1',
                    implementationPaths: ['src/foo.ts'],
                    testPaths: ['tests/foo.test.ts'],
                    evidence: [{ kind: 'test', command: 'vitest' }],
                    verificationLevel: 'unit',
                }],
            },
        });

        const result = await runCommand('build', taskId, root, { seal: true });
        const blockers = blockersOf(result);

        // The owned-paths blocker is collected alongside the one the fail-fast order would have reported first.
        expect(blockers.map((blocker) => blocker.code)).toEqual(['missingUpstreamCoverage', 'missingOwnedPaths']);
        expect(result.diagnostics).toMatchObject({ missingUpstreamCoverage: true, blockerCount: 2 });
        expect((result.diagnostics?.blockers as Array<{ diagnostics: Record<string, unknown> }>)[1]!.diagnostics).toMatchObject({ missingOwnedPaths: true });
    });
});
