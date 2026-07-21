import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendStateEvent, writeCurrentState } from './state.js';
import { assertValidTaskId } from './ids.js';
import { currentGitBranch } from './git.js';
export async function createTask(input) {
    const root = input.root ?? process.cwd();
    const now = new Date().toISOString();
    const id = input.id ?? `task-${randomUUID()}`;
    assertValidTaskId(id);
    const branch = currentGitBranch(root);
    const task = {
        id,
        title: input.title,
        phase: 'intake',
        acceptance: input.acceptance.map((criterion) => ({ ...criterion })),
        ...(branch ? { branch } : {}),
        createdAt: now,
        updatedAt: now,
        ...(input.workflowProfile ? { workflowProfile: input.workflowProfile } : {}),
        ...(input.ownedPaths?.length ? { ownedPaths: [...new Set(input.ownedPaths)].sort() } : {}),
        ...(input.acceptanceMatrix ? { acceptanceMatrix: input.acceptanceMatrix } : {}),
    };
    const taskDirectory = join(root, '.kata/tasks', task.id);
    await mkdir(taskDirectory, { recursive: true });
    await writeFile(join(taskDirectory, 'task.json'), `${JSON.stringify(task, null, 2)}\n`, 'utf8');
    const state = {
        taskId: task.id,
        phase: 'intake',
        actor: { id: 'system', role: 'system' },
        updatedAt: now,
    };
    await appendStateEvent(root, {
        taskId: task.id,
        from: null,
        to: 'intake',
        actor: state.actor,
        at: now,
    });
    await writeCurrentState(root, state);
    return task;
}
//# sourceMappingURL=task.js.map