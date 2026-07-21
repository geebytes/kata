import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertValidTaskId } from '../core/ids.js';
import { currentGitBranch } from '../core/git.js';
export async function activateHookTask(input) {
    assertValidTaskId(input.taskId);
    const phase = await readTaskPhase(input.root, input.taskId);
    const branch = currentGitBranch(input.root);
    const active = {
        taskId: input.taskId,
        role: input.role,
        phase,
        ...(input.platform ? { platform: input.platform } : {}),
        ...(branch ? { branch } : {}),
        origin: input.origin ?? 'manual',
        activatedAt: new Date().toISOString(),
    };
    const path = activeHookTaskPath(input.root);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(active, null, 2)}\n`, 'utf8');
    return active;
}
export { currentGitBranch };
export async function deactivateHookTask(root) {
    await rm(activeHookTaskPath(root), { force: true });
}
export async function readActiveHookTask(root) {
    try {
        return JSON.parse(await readFile(activeHookTaskPath(root), 'utf8'));
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT')
            return null;
        throw error;
    }
}
async function readTaskPhase(root, taskId) {
    const state = JSON.parse(await readFile(join(root, '.kata/tasks', taskId, 'current-state.json'), 'utf8'));
    return state.phase;
}
function activeHookTaskPath(root) {
    return join(root, '.kata/runtime/active-task.json');
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
//# sourceMappingURL=runtime.js.map