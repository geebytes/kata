import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { readTask } from '../../src/core/task.js';
import { validateMatrix } from '../../src/quality/acceptance-matrix.js';
import { runWorkflowCommand } from '../../src/cli/workflow.js';
import type { AcceptanceCriterionInput, AcceptanceMatrix } from '../../src/core/task.js';

/**
 * A strict task could not be opened into a designable state.
 *
 * `kata-cli open --review strict` writes the default `AC-1: Implement the change successfully.` and nothing else, while
 * `cmdDesign` refuses to run unless the task already carries an `acceptanceMatrix` — and `CreateTaskInput` had no field a
 * caller could use to supply one. The only way through was to hand-edit `task.json`, which is exactly the unverified
 * hand-written surface the review-record work exists to remove: the platform cannot produce its own contract, so it
 * demands that the author produce it, and then has no mechanism to check what the author wrote.
 *
 * These tests pin the bootstrap path: one file declares the acceptance criteria, the matrix and the upstream coverage,
 * and `open` writes all three. RED until `open` accepts it.
 */
describe('strict bootstrap', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function tempRoot(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-strict-bootstrap-'));
        roots.push(root);
        await initLayout(root);
        execFileSync('git', ['init', '--quiet'], { cwd: root });
        execFileSync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
        execFileSync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });
        return root;
    }

    const bootstrap: { acceptance: AcceptanceCriterionInput[]; acceptanceMatrix: AcceptanceMatrix } = {
        acceptance: [
            { id: 'AC-1', statement: 'The first criterion holds, and a test says so.' },
            { id: 'AC-2', statement: 'The second criterion holds, and a test says so.' },
        ],
        acceptanceMatrix: {
            version: 1,
            rows: [
                {
                    acceptanceId: 'AC-1',
                    implementationPaths: ['src/one.ts'],
                    testPaths: ['tests/unit/one.test.ts'],
                    evidence: [{ id: 'ac-1', kind: 'test', command: 'vitest', testSelector: 'tests/unit/one.test.ts' }],
                    verificationLevel: 'unit',
                },
                {
                    acceptanceId: 'AC-2',
                    implementationPaths: ['src/two.ts'],
                    testPaths: ['tests/unit/two.test.ts'],
                    evidence: [{ id: 'ac-2', kind: 'test', command: 'vitest', testSelector: 'tests/unit/two.test.ts' }],
                    verificationLevel: 'unit',
                },
            ],
        },
    };

    async function writeBootstrap(root: string, body: unknown = bootstrap): Promise<string> {
        const path = join(root, 'bootstrap.json');
        await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
        return path;
    }

    it('opens a strict task with the declared criteria and matrix, so design is reachable', async () => {
        const root = await tempRoot();
        const path = await writeBootstrap(root);

        const opened = await runCommand('open', 'boot-task', root, {
            title: 'Bootstrapped strict task',
            bootstrap: { acceptance: bootstrap.acceptance, acceptanceMatrix: bootstrap.acceptanceMatrix },
            workflowProfile: {
                version: 1,
                isolationMode: 'current_worktree',
                developmentMode: 'tdd',
                reviewMode: 'strict',
                comet: { projectInit: 'not_requested', openStatus: 'acknowledged' },
            },
        });
        expect(opened.success).toBe(true);

        const task = await readTask(root, 'boot-task');
        // The criteria are the caller's, not the placeholder the default path writes.
        expect(task.acceptance.map((criterion) => criterion.id)).toEqual(['AC-1', 'AC-2']);
        expect(task.acceptance[0]!.statement).toBe('The first criterion holds, and a test says so.');
        expect(task.acceptanceMatrix?.rows).toHaveLength(2);
        expect(validateMatrix(task.acceptance, task.acceptanceMatrix)).toEqual([]);

        // And the design gate that used to refuse now lets the task through.
        const designed = await runCommand('design', 'boot-task', root);
        expect(designed.success).toBe(true);
        expect(designed.phase).toBe('plan');
    });

    it('refuses a bootstrap whose matrix does not cover its criteria, at open, not three commands later', async () => {
        const root = await tempRoot();
        const partial = { version: 1 as const, rows: [bootstrap.acceptanceMatrix.rows[0]!] };

        const opened = await runCommand('open', 'boot-refused', root, {
            title: 'Bootstrapped strict task',
            bootstrap: { acceptance: bootstrap.acceptance, acceptanceMatrix: partial },
            workflowProfile: {
                version: 1,
                isolationMode: 'current_worktree',
                developmentMode: 'tdd',
                reviewMode: 'strict',
                comet: { projectInit: 'not_requested', openStatus: 'acknowledged' },
            },
        });

        expect(opened.success).toBe(false);
        expect(opened.error).toMatch(/no matrix row/i);
    });

    it('parses --bootstrap-file in the workflow CLI, so the CLI path is the same path', async () => {
        const root = await tempRoot();
        const path = await writeBootstrap(root);

        const result = await runWorkflowCommand(
            'open',
            'boot-cli',
            root,
            undefined,
            ['open', '--bootstrap-file', path, '--isolation', 'current_worktree', '--development', 'tdd', '--review', 'strict'],
        );
        expect(result.success).toBe(true);

        const task = await readTask(root, 'boot-cli');
        expect(task.acceptance.map((criterion) => criterion.id)).toEqual(['AC-1', 'AC-2']);
        // The file is read, not recorded as a path: the contract lives in the task, where the gates read it.
        expect(await readFile(path, 'utf8')).toContain('AC-1');
    });
});
