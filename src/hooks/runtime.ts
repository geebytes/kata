import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertValidTaskId } from '../core/ids.js';
import type { Phase } from '../core/state.js';
import { currentGitBranch } from '../core/git.js';

export type ActiveHookTask = {
  taskId: string;
  role: string;
  phase: Phase;
  platform?: string;
  branch?: string;
  origin?: 'manual' | 'discovered' | 'handoff' | 'workflow';
  activatedAt: string;
};

export async function activateHookTask(input: {
  root: string;
  taskId: string;
  role: string;
  platform?: string;
  origin?: ActiveHookTask['origin'];
}): Promise<ActiveHookTask> {
  assertValidTaskId(input.taskId);
  const phase = await readTaskPhase(input.root, input.taskId);
  const expectedRole = roleForPhase(phase);
  if (input.role !== expectedRole) {
    throw new Error(`Hook role ${input.role} does not match current phase ${phase}; expected ${expectedRole}.`);
  }
  const branch = currentGitBranch(input.root);
  const active: ActiveHookTask = {
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

function roleForPhase(phase: Phase): string {
  if (phase === 'intake' || phase === 'plan') return 'designer';
  if (phase === 'implement') return 'implementer';
  if (phase === 'hardVerify' || phase === 'review') return 'reviewer';
  if (phase === 'judge') return 'judge';
  if (phase === 'distill') return 'distiller';
  return 'approver';
}

export { currentGitBranch };

export async function deactivateHookTask(root: string): Promise<void> {
  await rm(activeHookTaskPath(root), { force: true });
}

export async function readActiveHookTask(root: string): Promise<ActiveHookTask | null> {
  try {
    return JSON.parse(await readFile(activeHookTaskPath(root), 'utf8')) as ActiveHookTask;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readTaskPhase(root: string, taskId: string): Promise<Phase> {
  const state = JSON.parse(await readFile(join(root, '.kata/tasks', taskId, 'current-state.json'), 'utf8')) as {
    phase: Phase;
  };
  return state.phase;
}

function activeHookTaskPath(root: string): string {
  return join(root, '.kata/runtime/active-task.json');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
