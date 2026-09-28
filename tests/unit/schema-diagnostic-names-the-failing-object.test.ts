import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readValidated } from '../../src/core/schema.js';

/**
 * **A schema diagnostic names the fields of the object the violation is in.**
 *
 * The hint came from the root schema whatever the violation, so a task.json carrying `workflowProfile.gitFlow.command` was
 * answered with the task's own field list:
 *
 *     $.workflowProfile.gitFlow.command is not allowed.
 *     Allowed fields: acceptance, acceptanceMatrix, …, upstreamCoverage, workflowProfile.       ← the wrong object
 *
 * The allowed set is exactly what makes the message a remedy rather than a symptom — the module's own docstring says so —
 * and an allowed set for an object the reader is not looking at sends them to the wrong place. Measured on that artefact,
 * the answer is now:
 *
 *     $.workflowProfile.gitFlow.command is not allowed.
 *     Fields allowed at $.workflowProfile.gitFlow: baseBranch, branch, …, strategy.
 *
 * Four properties: the nested object's fields, the failing object named in the message, `$ref` followed into the
 * referenced schema, and no field list where a field list is not the remedy.
 */
let root: string;

afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
});

/** A task record that is valid apart from the mutation the caller applies. */
function taskRecord(mutate: (task: Record<string, unknown>) => void): Record<string, unknown> {
    const task: Record<string, unknown> = {
        id: 'schema-task',
        title: 'Schema task',
        phase: 'intake',
        createdAt: '2026-09-28T00:00:00.000Z',
        updatedAt: '2026-09-28T00:00:00.000Z',
        acceptance: [{ id: 'AC-1', statement: 'x' }],
        ownedPaths: ['src/a.ts'],
        workflowProfile: {
            version: 1,
            isolationMode: 'git_flow',
            developmentMode: 'tdd',
            reviewMode: 'strict',
            gitFlow: { strategy: 'manual', branch: 'feature/x', baseBranch: 'develop', status: 'active' },
            comet: { openStatus: 'required' },
            strictClosure: false,
        },
    };
    mutate(task);
    return task;
}

async function diagnosticAgainst(schemaName: string, value: Record<string, unknown>): Promise<string> {
    root = await mkdtemp(join(tmpdir(), 'kata-schema-hint-'));
    const path = join(root, 'artefact.json');
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    return readValidated(schemaName, path).then(
        () => 'NO REFUSAL',
        (error: Error) => error.message,
    );
}

describe('a schema diagnostic names the object it is about', () => {
    it('lists the failing sub-object’s fields, not the root’s', async () => {
        const message = await diagnosticAgainst('task', taskRecord((task) => {
            (task.workflowProfile as Record<string, unknown>).gitFlow = {
                strategy: 'manual', branch: 'feature/x', baseBranch: 'develop', status: 'active',
                // The property measured in a downstream repository: `GitFlowPlan` extends `GitFlowState`, so a plan reached
                // `task.json` and every git_flow task failed its own schema on the next read.
                command: [],
            };
        }));
        expect(message).toContain('$.workflowProfile.gitFlow.command is not allowed');
        expect(message).toContain('Fields allowed at $.workflowProfile.gitFlow:');
        expect(message).toContain('strategy');
        expect(message).toContain('baseBranch');
        // The regression, stated: the root's own fields must not be offered as the answer.
        expect(message).not.toContain('acceptanceMatrix');
        expect(message).not.toContain('Allowed fields: acceptance,');
    });

    it('names the missing fields at the object that wants them', async () => {
        const message = await diagnosticAgainst('task', taskRecord((task) => {
            (task.workflowProfile as Record<string, unknown>).gitFlow = { strategy: 'manual', branch: 'feature/x' };
        }));
        expect(message).toMatch(/\$\.workflowProfile\.gitFlow\.baseBranch is required/);
        expect(message).toContain('Fields required at $.workflowProfile.gitFlow:');
    });

    it('follows a $ref into the referenced schema', async () => {
        // `review.schema.json`'s findings are `$ref`s to `review-finding.schema.json`, so the walk has to switch documents
        // to name the finding's own fields. One ref exists today; the walk is written for the second.
        // The finding needs its own required fields, or the refusal is about a missing one and the ref walk is never
        // exercised — which is how the first version of this case passed nothing.
        const message = await diagnosticAgainst('review', {
            status: 'pending',
            findings: [{ id: 'f1', taskId: 't', severity: 'minor', message: 'x', bogus: true }],
        });
        expect(message).toContain('is not allowed');
        expect(message).toMatch(/Fields allowed at \$\.findings\[0\]:/);
        expect(message).not.toContain('Fields allowed at $:');
    });

    it('does not offer a field list where a field list is not the remedy', async () => {
        // A wrong value is answered by the value: `status` must be one of an enum, and listing the object's fields there
        // would read like advice.
        const message = await diagnosticAgainst('task', taskRecord((task) => {
            task.phase = 'not-a-phase';
        }));
        expect(message).toContain('$.phase must be');
        expect(message).not.toContain('Fields allowed at');
        expect(message).not.toContain('Fields required at');
    });
});
