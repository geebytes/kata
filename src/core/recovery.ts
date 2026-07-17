import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readStateEvents, writeCurrentState, type StateRecord } from './state.js';

export interface RecoveryOptions {
  root?: string;
}

export interface RecoveryDiagnostic {
  taskId: string;
  phase: string;
  recoveredActiveSession?: string;
  actions: string[];
}

export async function recover(taskId: string, options: RecoveryOptions = {}): Promise<RecoveryDiagnostic> {
  const root = options.root ?? process.cwd();
  const events = await readStateEvents(root, taskId);
  if (events.length === 0) throw new Error(`No state events found for task ${taskId}`);

  const latest = events[events.length - 1];
  const latestSession = [...events].reverse().find((event) => event.activeSession)?.activeSession;
  const current: StateRecord = {
    taskId,
    phase: latest.to,
    actor: latest.actor,
    updatedAt: latest.at,
    ...(latestSession ? { activeSession: latestSession } : {}),
  };
  const actions: string[] = [];

  let pointerMatches = false;
  if (latestSession) {
    try {
      const pointer = JSON.parse(await readFile(activeSessionPath(root), 'utf8')) as {
        taskId?: string;
        activeSession?: string;
      };
      pointerMatches = pointer.taskId === taskId && pointer.activeSession === latestSession;
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
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

async function writeCurrentStatePointer(root: string, taskId: string, activeSession: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(activeSessionPath(root), `${JSON.stringify({ taskId, activeSession }, null, 2)}\n`, 'utf8');
}

function activeSessionPath(root: string): string {
  return join(root, '.kata/runtime/active-session.json');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
