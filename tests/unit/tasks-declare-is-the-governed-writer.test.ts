import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask, readTask } from '../../src/core/task.js';
import { declarationChangesPath, declareTaskField } from '../../src/quality/declaration-change.js';

/**
 * **The declarations a task carries have a governed writer, and it enforces what the readers enforce.**
 *
 * Until this module neither `upstreamCoverage` nor `acceptanceMatrix` had a command. Measured while walking a real
 * change: `design` refused with `Design blocked: 1 acceptance criterion(s) have no upstream requirement (AC-1)`, and the
 * only remedy available to the author was to edit `task.json` by hand — outside every lock, with no record of who decided
 * or why. `ownedPaths` already had `scope change`; these two had nothing, which is the defect class this repository
 * records most: a declaration with a reader and no governed writer.
 *
 * The rule the reader enforces is enforced at the write, so the hand-edit route cannot produce a task the next command
 * must reject — and a refusal writes nothing at all, which is the half a caller cannot check afterwards.
 */
let root: string;

afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
    root = await mkdtemp(join(tmpdir(), 'kata-declare-'));
    await initLayout(root);
    await createTask({
        root,
        id: 'declare-task',
        title: 'Declare task',
        acceptance: [{ id: 'AC-1', statement: 'first' }, { id: 'AC-2', statement: 'second' }],
        ownedPaths: ['src/a.ts'],
    });
    return root;
}

const coverage = (...mappedTo: string[]) => ({
    version: 1,
    sources: [
        {
            ref: 'openspec/specs/x/spec.md',
            requirements: mappedTo.map((acId, index) => ({ id: `R${index + 1}`, statement: 'the runtime SHALL', mappedTo: acId })),
        },
    ],
});

describe('tasks declare is the governed writer for a task declaration', () => {
    it('records the decision and writes the declaration', async () => {
        const workspaceRoot = await workspace();
        const result = await declareTaskField({
            root: workspaceRoot,
            taskId: 'declare-task',
            field: 'upstreamCoverage',
            value: coverage('AC-1', 'AC-2'),
            reason: 'the delta spec names the requirement this criterion comes from',
            by: 'pi',
        });
        expect(result.ok).toBe(true);
        const task = await readTask(workspaceRoot, 'declare-task');
        expect(task?.upstreamCoverage?.sources).toHaveLength(1);
        // The record is written, and it says who decided and why — which is what the hand-edit route could not produce.
        const log = await readFile(declarationChangesPath(workspaceRoot, 'declare-task'), 'utf8');
        expect(log).toContain('"by":"pi"');
        expect(log).toContain('the delta spec names the requirement');
    });

    it('refuses coverage that leaves a criterion unmapped, and writes nothing', async () => {
        // The measured refusal, enforced at the write: `design` would reject this task, so the writer must not create it.
        const workspaceRoot = await workspace();
        const before = await readFile(join(workspaceRoot, '.kata/tasks/declare-task/task.json'), 'utf8');
        const result = await declareTaskField({
            root: workspaceRoot,
            taskId: 'declare-task',
            field: 'upstreamCoverage',
            value: coverage('AC-1'),
            reason: 'partial on purpose',
            by: 'pi',
        });
        // AC-2 is unmapped, so this is refused — and the message names it.
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.refused).toContain('AC-2');
        // Nothing written: neither the task nor the decision log.
        await expect(readFile(join(workspaceRoot, '.kata/tasks/declare-task/task.json'), 'utf8')).resolves.toBe(before);
        await expect(readFile(declarationChangesPath(workspaceRoot, 'declare-task'), 'utf8')).rejects.toThrow();
    });

    it('requires a reason, because an unexplained declaration change is drift', async () => {
        const workspaceRoot = await workspace();
        const result = await declareTaskField({
            root: workspaceRoot,
            taskId: 'declare-task',
            field: 'acceptanceMatrix',
            value: { version: 1, rows: [] },
            reason: '   ',
            by: 'pi',
        });
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.refused).toContain('--reason');
    });

    it('refuses a payload that would not be a valid task record', async () => {
        const workspaceRoot = await workspace();
        const result = await declareTaskField({
            root: workspaceRoot,
            taskId: 'declare-task',
            field: 'acceptanceMatrix',
            value: { version: 1, rows: 'not an array' },
            reason: 'a shape the schema rejects',
            by: 'pi',
        });
        expect(result.ok).toBe(false);
        // Validated against the task schema rather than a second shape, so the refusal comes from the schema's own message.
        expect(result.ok === false && result.refused).toContain('valid task record');
        await expect(readFile(declarationChangesPath(workspaceRoot, 'declare-task'), 'utf8')).rejects.toThrow();
    });

    it('refuses a declaration for a task that does not exist', async () => {
        const workspaceRoot = await workspace();
        const result = await declareTaskField({
            root: workspaceRoot,
            taskId: 'no-such-task',
            field: 'upstreamCoverage',
            value: coverage('AC-1'),
            reason: 'typo in the id',
            by: 'pi',
        });
        expect(result.ok).toBe(false);
        expect(result.ok === false && result.refused).toContain('no task');
    });
});
