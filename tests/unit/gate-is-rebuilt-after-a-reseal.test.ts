import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    GATE_CREATED_BY,
    approveUserChoiceGate,
    boundaryCreatedBy,
    createUserChoiceGate,
    gateRebuildInstruction,
} from '../../src/workflow/user-choice-gate.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { userChoiceGatePath } from '../../src/core/layout.js';

/**
 * **A gate is bound to the content it was answered for, so re-sealing has to recreate it.**
 *
 * Measured, on this change's own long run: after a re-seal the `review_gate` approval was refused with "not bound to the
 * current revision or its content", and the way forward turned out to be *re-running the command that creates the gate* —
 * a fact that lived only in the CLI's inline branch chain. Nothing in the refusal or the documentation said so, and the
 * operator's reasonable inference (approve harder) could not work: the gate has to be rebuilt, not re-answered.
 *
 * The creation rule and the rebuild instruction now read one table, so both directions of the same fact come from one
 * place: `cli/workflow.ts` asks `boundaryCreatedBy` which boundary a finished command creates, and the refusal asks
 * `gateRebuildInstruction` how to get a new one.
 */
const NOW = '2026-09-29T00:00:00.000Z';
const roots: string[] = [];
let root: string;
const taskId = 'gate-rebuild';

afterEach(async () => {
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-gate-rebuild-'));
    roots.push(root);
    await mkdir(join(root, '.kata', 'tasks', taskId, 'review'), { recursive: true });
    await writeFile(join(root, 'subject.ts'), 'export const version = 1;\n');
    await writeFile(
        join(root, '.kata', 'tasks', taskId, 'task.json'),
        `${JSON.stringify({ id: taskId, title: 'T', phase: 'hardVerify', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['subject.ts'], createdAt: NOW, updatedAt: NOW })}\n`,
    );
    await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: [] });
});

/** The gate as it exists on disk, through the layout's own path rather than a guessed filename. */
async function gate(): Promise<Record<string, unknown> | null> {
    try {
        return JSON.parse(await readFile(userChoiceGatePath(root, taskId, 'review_gate'), 'utf8')) as Record<string, unknown>;
    } catch {
        return null;
    }
}

describe('each boundary knows which command creates it', () => {
    it('names exactly the command and phase that produce it, because the refusal reads the same table', () => {
        expect(GATE_CREATED_BY.review_gate).toEqual({ command: 'verify', phase: 'hardVerify' });
        expect(GATE_CREATED_BY.judge_gate).toEqual({ command: 'review', phase: 'review' });
        // And the two directions agree: asking by phase and command returns the boundary the table maps to it.
        expect(boundaryCreatedBy('hardVerify', 'verify')).toBe('review_gate');
        expect(boundaryCreatedBy('review', 'review', true)).toBe('judge_gate');
        // A review that records findings opens a repair rather than a gate, so the approving flag is part of the fact.
        expect(boundaryCreatedBy('review', 'review', false)).toBeNull();
        expect(boundaryCreatedBy('implement', 'build')).toBeNull();
    });

    it('tells an operator how to rebuild each gate, naming the command rather than the phase', () => {
        for (const [boundary, entry] of Object.entries(GATE_CREATED_BY)) {
            const instruction = gateRebuildInstruction(boundary as keyof typeof GATE_CREATED_BY);
            expect(instruction, boundary).toContain('kata-cli');
            expect(instruction, boundary).toContain(entry.command);
        }
    });
});

describe('a re-seal leaves a gate that no longer speaks for the content', () => {
    it('refuses the stale approval and names the command that rebuilds the gate', async () => {
        await createUserChoiceGate({ root, taskId, boundary: 'review_gate' });
        expect(await gate()).not.toBeNull();

        await writeFile(join(root, 'subject.ts'), 'export const version = 2;\n');
        await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: [] });

        const refusal = await approveUserChoiceGate({ root, taskId, boundary: 'review_gate', choice: 'continue_current' })
            .catch((error: Error) => error.message);
        expect(String(refusal)).toContain('not bound');
        expect(String(refusal)).toContain('kata-cli verify');
    });

    it('accepts a gate recreated against the content that is current now', async () => {
        await createUserChoiceGate({ root, taskId, boundary: 'review_gate' });
        await writeFile(join(root, 'subject.ts'), 'export const version = 2;\n');
        await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: [] });

        // What the named command does: it concludes, which recreates the boundary's gate against the content it saw.
        await createUserChoiceGate({ root, taskId, boundary: 'review_gate' });
        await approveUserChoiceGate({ root, taskId, boundary: 'review_gate', choice: 'continue_current' });
        const approved = await gate();
        expect(approved?.choice).toBe('continue_current');
    });
});