import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertValidTaskId } from '../core/ids.js';
import type { Phase } from '../core/state.js';
import { activeRoleForPhase } from '../workflow/navigation.js';
import { ensureRuntimeGitignore } from '../core/layout.js';
import { currentGitBranch } from '../core/git.js';
import { currentStatePath as layoutCurrentStatePath, activeTaskPath as layoutActiveTaskPath } from '../core/layout.js';

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
  const expectedRole = activeRoleForPhase(phase);
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
  // Writing the session pointer is the moment the ignore rule matters: an unignored pointer gets committed, and a
  // worktree or a fresh clone then checks out an "active task" nobody activated there. The rule is written first so the
  // pointer can never be staged by accident; a workspace that already has it is unchanged.
  await ensureRuntimeGitignore(input.root).catch(() => null);
  const path = activeHookTaskPath(input.root);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(active, null, 2)}\n`, 'utf8');
  return active;
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
  const state = JSON.parse(await readFile(layoutCurrentStatePath(root, taskId), 'utf8')) as {
    phase: Phase;
  };
  return state.phase;
}

function activeHookTaskPath(root: string): string {
  return layoutActiveTaskPath(root);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
