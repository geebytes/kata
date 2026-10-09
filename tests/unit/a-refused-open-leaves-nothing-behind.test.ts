import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { readTask } from '../../src/core/task.js';
import type { AcceptanceCriterionInput, AcceptanceMatrix } from '../../src/core/task.js';

/**
 * **AC-11 — a refusal must leave nothing behind, describe what it did honestly, and name a remedy that runs.**
 *
 * Measured: `kata-cli open --bootstrap-file <record its own schema rejects>` refused with "…the record would not match its
 * schema… Nothing was written." — while an empty `.kata/tasks/<id>` *had* been created, because the directory was made
 * before the record was validated. The consequences compound from there: the next `open` of the same id was refused with
 * "Task <id> already exists; use kata status --change <id> to resume it", and `status --change <id>` answered ENOENT,
 * because there was no state record to resume. One refusal produced state, misdescribed it, and named a command that
 * cannot work — the same family as the review ladder printing a command it refuses.
 *
 * These cases pin all three, in that order: nothing on disk, the message matching the disk, and the id still openable.
 */
const roots: string[] = [];

async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-refused-open-'));
    roots.push(root);
    await initLayout(root);
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });
    return root;
}

const acceptance: AcceptanceCriterionInput[] = [
    { id: 'AC-1', statement: 'The first criterion holds, and a test says so.' },
    { id: 'AC-2', statement: 'The second criterion holds, and a test says so.' },
];
const matrix: AcceptanceMatrix = {
    version: 1,
    rows: [
        { acceptanceId: 'AC-1', implementationPaths: ['src/one.ts'], testPaths: ['tests/unit/one.test.ts'], evidence: [{ id: 'ac-1', kind: 'test', command: 'vitest', testSelector: 'tests/unit/one.test.ts' }], verificationLevel: 'unit' },
        { acceptanceId: 'AC-2', implementationPaths: ['src/two.ts'], testPaths: ['tests/unit/two.test.ts'], evidence: [{ id: 'ac-2', kind: 'test', command: 'vitest', testSelector: 'tests/unit/two.test.ts' }], verificationLevel: 'unit' },
    ],
};

const profile = {
    version: 1 as const,
    isolationMode: 'current_worktree' as const,
    developmentMode: 'tdd' as const,
    reviewMode: 'strict' as const,
    comet: { projectInit: 'not_requested' as const, openStatus: 'acknowledged' as const },
};

/** A source with no `ref`: valid to the bootstrap reader, refused by the task record's own schema. */
const invalidRecord = { version: 1, sources: [{ id: 'S1', statement: 'a requirement nobody can trace' }] };

async function taskEntries(root: string): Promise<string[]> {
    return readdir(join(root, '.kata', 'tasks')).catch(() => []);
}

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('a refused kata open leaves nothing behind', () => {
    it('writes no task directory, and its message does not claim otherwise', async () => {
        const root = await tempRoot();

        // The refusal is thrown as well as printed, so both faces are asserted: the message an operator sees, and the
        // state the message claims.
        const refused = await runCommand('open', 'refused-open', root, {
            title: 'Refused bootstrap',
            bootstrap: { acceptance, acceptanceMatrix: matrix, upstreamCoverage: invalidRecord as never },
            workflowProfile: profile,
        }).catch((error: Error) => error.message);

        expect(String(refused)).toContain('would not match its schema');
        expect(String(refused)).toContain('Nothing was written.');
        // The claim is now the truth: measured before the fix, this directory existed and was empty.
        expect(await taskEntries(root)).not.toContain('refused-open');
        await expect(readFile(join(root, '.kata', 'tasks', 'refused-open', 'task.json'), 'utf8')).rejects.toThrow();
    });

    it('lets the same id be opened afterwards, instead of refusing it as already existing', async () => {
        const root = await tempRoot();
        await runCommand('open', 'reopen-after-refusal', root, {
            title: 'Refused bootstrap',
            bootstrap: { acceptance, acceptanceMatrix: matrix, upstreamCoverage: invalidRecord as never },
            workflowProfile: profile,
        }).catch(() => undefined);

        const opened = await runCommand('open', 'reopen-after-refusal', root, {
            title: 'Corrected bootstrap',
            bootstrap: { acceptance, acceptanceMatrix: matrix },
            workflowProfile: profile,
        });

        expect(opened.success, JSON.stringify(opened)).toBe(true);
        // And the state the refusal's remedy names is now real, so `status --change <id>` has something to read.
        const task = await readTask(root, 'reopen-after-refusal');
        expect(task.id).toBe('reopen-after-refusal');
        expect(task.phase).toBe('intake');
    });

    it('still refuses a second open of a task that really exists, with the resume remedy', async () => {
        const root = await tempRoot();
        const first = await runCommand('open', 'really-exists', root, {
            title: 'First',
            bootstrap: { acceptance, acceptanceMatrix: matrix },
            workflowProfile: profile,
        });
        expect(first.success, JSON.stringify(first)).toBe(true);

        const second = await runCommand('open', 'really-exists', root, {
            title: 'Second',
            bootstrap: { acceptance, acceptanceMatrix: matrix },
            workflowProfile: profile,
        }).catch((error: Error) => error.message);

        expect(String(second)).toMatch(/already exists/);
        expect(String(second)).toMatch(/status --change really-exists/);
    });
});
