import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    approveUserChoiceGate,
    boundaryCreatedBy,
    consumeUserChoiceGate,
    createUserChoiceGate,
} from '../../src/workflow/user-choice-gate.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { boundaryForCommand } from '../../src/cli/workflow.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { currentStatePath, userChoiceGatePath } from '../../src/core/layout.js';

/**
 * **A task that re-enters review gets a gate it can use.**
 *
 * Reported from another checkout and reproduced here: a task sitting in `review` whose gate was already consumed could not
 * go anywhere. `gate approve` answered "has already been consumed" and named no next step; `review --confirm-host-model`
 * refused and reported `phase=hardVerify` while `current-state.json` said `review`; and the remedy the *other* refusal
 * prints — "run the command that creates this boundary's gate" — did not work either, because the table that decides which
 * command creates which boundary was keyed on the phase a command **reports** (`cmdVerify` reports the phase it entered
 * with), so a `verify` run from `review` never recreated the gate. The only way out was `build --seal`, which mints a
 * revision for content that did not change.
 *
 * Three surfaces, one class: a surface reporting or keying on a phase it assumed rather than the one it read.
 */
const NOW = '2026-10-08T00:00:00.000Z';
const roots: string[] = [];
let root: string;
const taskId = 'gate-reentry';

afterEach(async () => {
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-gate-reentry-'));
    roots.push(root);
    await mkdir(join(root, '.kata', 'tasks', taskId, 'review'), { recursive: true });
    await writeFile(join(root, 'subject.ts'), 'export const version = 1;\n');
    await writeFile(
        join(root, '.kata', 'tasks', taskId, 'task.json'),
        `${JSON.stringify({ id: taskId, title: 'T', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['subject.ts'], createdAt: NOW, updatedAt: NOW })}\n`,
    );
    // **In `review`, which is the state that deadlocked.** The store is written through its own path helper, the way every
    // other reader resolves it, so the fixture cannot invent a location the code does not use.
    await writeFile(
        currentStatePath(root, taskId),
        `${JSON.stringify({ taskId, phase: 'review', actor: { id: 'fixture', role: 'reviewer' }, updatedAt: NOW })}\n`,
    );
    await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: [] });
});

/** The gate as it exists on disk. */
async function gate(): Promise<Record<string, unknown> | null> {
    try {
        return JSON.parse(await readFile(userChoiceGatePath(root, taskId, 'review_gate'), 'utf8')) as Record<string, unknown>;
    } catch {
        return null;
    }
}

/** The gate in the state the report measured: answered, used, and left behind. */
async function consumedGate(): Promise<void> {
    await createUserChoiceGate({ root, taskId, boundary: 'review_gate' });
    await approveUserChoiceGate({ root, taskId, boundary: 'review_gate', choice: 'continue_current' });
    await consumeUserChoiceGate({ root, taskId, boundary: 'review_gate' });
}

describe('the boundary table answers from the command, not from the phase it assumed', () => {
    it('creates the review gate for a successful verify whatever phase verify entered from', () => {
        expect(boundaryCreatedBy('hardVerify', 'verify')).toBe('review_gate');
        // **The line the deadlock came from.** A verify run from `review` reports `review`, and the table had no entry for
        // it — so the command the refusal tells an operator to run did nothing at all.
        expect(boundaryCreatedBy('review', 'verify')).toBe('review_gate');

        // Controls, so the fix is not "return review_gate for everything": the other boundaries keep their conditions.
        expect(boundaryCreatedBy('review', 'review', true)).toBe('judge_gate');
        expect(boundaryCreatedBy('review', 'review', false)).toBeNull();
        expect(boundaryCreatedBy('implement', 'build')).toBeNull();
        expect(boundaryCreatedBy('hardVerify', 'design')).toBeNull();
    });

    it('replaces a consumed gate with a fresh one, and the fresh one can be answered', async () => {
        await consumedGate();
        expect((await gate())?.consumedAt).toBeDefined();

        // What the CLI does after a successful phase command: ask the table, then create.
        const boundary = boundaryCreatedBy('review', 'verify');
        expect(boundary).toBe('review_gate');
        await createUserChoiceGate({ root, taskId, boundary: boundary as 'review_gate' });

        const fresh = await gate();
        expect(fresh?.consumedAt).toBeUndefined();
        expect(fresh?.choice).toBeUndefined();
        await approveUserChoiceGate({ root, taskId, boundary: 'review_gate', choice: 'continue_current' });
        expect((await gate())?.choice).toBe('continue_current');
    });
});

describe('the command asks for its boundary in the phase it is already in', () => {
    it('asks for the review gate from review, which is what the confirmation is derived from', () => {
        // `confirmHostModel` is `boundary !== null`: no boundary means no confirmation, which is why a task in `review`
        // refused with "requires explicit user confirmation" while holding an approved gate.
        expect(boundaryForCommand('review', 'hardVerify')).toBe('review_gate');
        expect(boundaryForCommand('review', 'review')).toBe('review_gate');
        // The other commands keep their conditions, including the phase they are already in.
        expect(boundaryForCommand('judge', 'review')).toBe('judge_gate');
        expect(boundaryForCommand('judge', 'judge')).toBe('judge_gate');
        expect(boundaryForCommand('archive', 'archive')).toBe('archive_gate');
        expect(boundaryForCommand('build', 'plan')).toBe('implementation_gate');
        expect(boundaryForCommand('build', 'implement')).toBeNull();
        expect(boundaryForCommand('verify', 'review')).toBeNull();
    });
});

describe('a refusal names the next step', () => {
    it('tells the operator how to rebuild a gate that was already consumed', async () => {
        await consumedGate();

        const refusal = await approveUserChoiceGate({ root, taskId, boundary: 'review_gate', choice: 'continue_current' })
            .catch((error: Error) => error.message);
        expect(String(refusal)).toContain('already been consumed');
        // The same remedy sentence the stale-revision branch prints: the command that recreates this boundary.
        expect(String(refusal)).toContain('kata-cli verify');
    });
});

describe('a refusal reports the phase the task holds', () => {
    it('reports review, not the phase the review command assumed', async () => {
        await consumedGate();
        // A fresh gate, answered: the command is allowed to reach its own confirmation check.
        await createUserChoiceGate({ root, taskId, boundary: 'review_gate' });
        await approveUserChoiceGate({ root, taskId, boundary: 'review_gate', choice: 'continue_current' });

        const result = await runCommand('review', taskId, root);
        expect(result.success).toBe(false);
        // `current-state.json` says `review`; the refusal used to say `hardVerify`, which is what an operator would act on.
        expect(result.phase).toBe('review');
        expect(String(result.error)).toContain('confirmation');
    });
});
