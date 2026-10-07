import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approveUserChoiceGate, consumeUserChoiceGate, createUserChoiceGate } from '../../src/workflow/user-choice-gate.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { currentStatePath, userChoiceGatePath } from '../../src/core/layout.js';

/**
 * **A task in `review`, which is the state the reported deadlock could not leave.**
 *
 * Shared by the three guards that each prove one part of the re-entry: the boundary table, the phase a refusal reports, and
 * the remedy a refusal names. It lives here rather than three times over because the fixture is the *state under test* —
 * three copies would drift into three subtly different states, which is how the same defect gets three different answers.
 */
const NOW = '2026-10-08T00:00:00.000Z';

export type GateFixture = {
    root: string;
    taskId: string;
    /** The gate as it exists on disk, or null when there is none. */
    gate: () => Promise<Record<string, unknown> | null>;
    /** A gate answered, used, and left behind: the state the report measured. */
    consumedGate: () => Promise<void>;
    /** A gate answered and not yet used, which is what a successful phase command leaves. */
    freshGate: () => Promise<void>;
    cleanup: () => Promise<void>;
};

export async function gateFixture(taskId = 'gate-reentry'): Promise<GateFixture> {
    const root = await mkdtemp(join(tmpdir(), 'kata-gate-reentry-'));
    await mkdir(join(root, '.kata', 'tasks', taskId, 'review'), { recursive: true });
    await writeFile(join(root, 'subject.ts'), 'export const version = 1;\n');
    await writeFile(
        join(root, '.kata', 'tasks', taskId, 'task.json'),
        `${JSON.stringify({ id: taskId, title: 'T', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['subject.ts'], createdAt: NOW, updatedAt: NOW })}\n`,
    );
    // Written through the layout's own path helper, so the fixture cannot invent a location the code does not use.
    await writeFile(
        currentStatePath(root, taskId),
        `${JSON.stringify({ taskId, phase: 'review', actor: { id: 'fixture', role: 'reviewer' }, updatedAt: NOW })}\n`,
    );
    await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: [] });

    return {
        root,
        taskId,
        gate: async () => {
            try {
                return JSON.parse(await readFile(userChoiceGatePath(root, taskId, 'review_gate'), 'utf8')) as Record<string, unknown>;
            } catch {
                return null;
            }
        },
        consumedGate: async () => {
            await createUserChoiceGate({ root, taskId, boundary: 'review_gate' });
            await approveUserChoiceGate({ root, taskId, boundary: 'review_gate', choice: 'continue_current' });
            await consumeUserChoiceGate({ root, taskId, boundary: 'review_gate' });
        },
        freshGate: async () => {
            await createUserChoiceGate({ root, taskId, boundary: 'review_gate' });
            await approveUserChoiceGate({ root, taskId, boundary: 'review_gate', choice: 'continue_current' });
        },
        cleanup: async () => {
            await rm(root, { recursive: true, force: true });
        },
    };
}
