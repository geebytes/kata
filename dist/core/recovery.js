import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readStateEvents, writeCurrentState } from './state.js';
export async function recover(taskId, options = {}) {
    const root = options.root ?? process.cwd();
    const events = await readStateEvents(root, taskId);
    if (events.length === 0)
        throw new Error(`No state events found for task ${taskId}`);
    const latest = events[events.length - 1];
    const latestSession = [...events].reverse().find((event) => event.activeSession)?.activeSession;
    const current = {
        taskId,
        phase: latest.to,
        actor: latest.actor,
        updatedAt: latest.at,
        ...(latestSession ? { activeSession: latestSession } : {}),
    };
    const actions = [];
    let pointerMatches = false;
    if (latestSession) {
        try {
            const pointer = JSON.parse(await readFile(activeSessionPath(root), 'utf8'));
            pointerMatches = pointer.taskId === taskId && pointer.activeSession === latestSession;
        }
        catch (error) {
            if (!isNodeError(error) || error.code !== 'ENOENT')
                throw error;
        }
    }
    await writeCurrentState(root, current);
    actions.push('rewrote-current-state');
    if (latestSession && !pointerMatches) {
        await mkdir(join(root, '.kata/runtime'), { recursive: true });
        await writeCurrentStatePointer(root, taskId, latestSession);
        actions.push('rewrote-active-session-pointer');
    }
    return {
        taskId,
        phase: latest.to,
        ...(latestSession ? { recoveredActiveSession: latestSession } : {}),
        actions,
    };
}
async function writeCurrentStatePointer(root, taskId, activeSession) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(activeSessionPath(root), `${JSON.stringify({ taskId, activeSession }, null, 2)}\n`, 'utf8');
}
function activeSessionPath(root) {
    return join(root, '.kata/runtime/active-session.json');
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
//# sourceMappingURL=recovery.js.map