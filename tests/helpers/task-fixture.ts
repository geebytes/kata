import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultWorkflowProfile } from '../../src/core/workflow-profile.js';

/**
 * **A fixture's `task.json` is a record of the store, so it has to satisfy the store's schema.**
 *
 * Measured: fifteen cases across seven files wrote a hand-rolled record that omitted `phase` (and often `createdAt` /
 * `updatedAt`). Nothing noticed while the readers that touch the task record were wrapped in `.catch(() => null)`, which
 * answered "no task" for a record that did not match its schema — so the fixtures were free to drift from the shape the
 * production writer mints, and the drift was invisible exactly as long as damage was invisible.
 *
 * The readers now tell drift from absence, and the fifteen cases failed for the fixture's reason rather than the code's.
 * The fix is not to loosen the readers — a record that does not match its schema is `unreadable`, and reporting it is the
 * behaviour under test. The fix is to stop hand-rolling the shape: one place writes a valid record, and a fixture that
 * needs a different field passes it in.
 *
 * `phase` is required by the schema and is a fact about the task rather than about the command under test, so the caller
 * names it. Everything else the schema requires has a default here, because a fixture that omits it is describing an
 * impossible record rather than a minimal one.
 */
export interface TaskFixtureInput {
    id: string;
    /** The phase the task holds. Required: the schema requires it, and the store's own writer always stamps it. */
    phase: 'intake' | 'plan' | 'implement' | 'hardVerify' | 'review' | 'judge' | 'distill' | 'archive';
    title?: string;
    acceptance?: Array<{ id: string; statement: string }>;
    ownedPaths?: string[];
    workflowProfile?: Record<string, unknown>;
    at?: string;
}

/** The record, as an object — for a case that has to compose it with something else before writing. */
export function taskRecord(input: TaskFixtureInput): Record<string, unknown> {
    const at = input.at ?? '2026-10-08T00:00:00.000Z';
    return {
        id: input.id,
        title: input.title ?? 'Fixture',
        phase: input.phase,
        acceptance: input.acceptance ?? [{ id: 'AC-1', statement: 'It holds.' }],
        createdAt: at,
        updatedAt: at,
        ...(input.ownedPaths ? { ownedPaths: input.ownedPaths } : {}),
        // Merged over the profile the store itself mints, never substituted for it: `workflowProfile` requires all seven
        // of its fields, so a fixture that passed only `{ reviewMode }` wrote a record its own reader refuses — which is
        // how the same drift appeared a second time, one field deeper, after the first was fixed.
        ...(input.workflowProfile ? { workflowProfile: { ...defaultWorkflowProfile(), ...input.workflowProfile } } : {}),
    };
}

/** Write the record where the store keeps it, so a fixture cannot invent a location the code does not use. */
export async function writeTaskRecord(root: string, input: TaskFixtureInput): Promise<void> {
    await writeFile(join(root, '.kata', 'tasks', input.id, 'task.json'), `${JSON.stringify(taskRecord(input), null, 2)}\n`);
}
