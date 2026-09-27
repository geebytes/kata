import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isReplayableTransition, readStateEventLog, writeCurrentState, type StateEvent, type StateRecord } from './state.js';
import { runtimeDir } from './layout.js';

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
  const log = await readStateEventLog(root, taskId);
  const events = log.events;
  if (events.length === 0) throw new Error(`No state events found for task ${taskId}`);

  const validEvents = replayValidEvents(events);
  if (validEvents.length === 0) throw new Error(`No legal state events found for task ${taskId}`);
  const latest = validEvents[validEvents.length - 1]!;
  const latestSession = [...validEvents].reverse().find((event) => event.activeSession)?.activeSession;
  const current: StateRecord = {
    taskId,
    phase: latest.to,
    actor: latest.actor,
    updatedAt: latest.at,
    ...(latestSession ? { activeSession: latestSession } : {}),
  };
  const actions: string[] = [];
  if (validEvents.length !== events.length) actions.push(`ignored-${events.length - validEvents.length}-invalid-state-events`);
  // **The log's own damage is reported, not inferred from a shorter replay.** A crash truncates the tail, and the reader
  // tolerates it; anything else means the chain broke mid-file, and a reader that is handed the surviving prefix has to be
  // told what it is missing — a shorter history that looks complete is the failure this reports.
  if (log.malformed > 0) actions.push(`${log.truncatedTail ? 'truncated' : 'damaged'}-state-event-log:${log.malformed}-line(s)`);

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
    await mkdir(runtimeDir(root), { recursive: true });
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

export async function requiresRecovery(taskId: string, options: RecoveryOptions = {}): Promise<boolean> {
  const root = options.root ?? process.cwd();
  const log = await readStateEventLog(root, taskId);
  // **A damaged log needs recovery even when every surviving event replays.** The old test compared the replayed length
  // against the parsed length, so a truncated tail — tolerated by the reader, and invisible in the shorter list — read as
  // "nothing to recover", which is precisely the state it exists to detect.
  if (log.malformed > 0) return true;
  return replayValidEvents(log.events).length !== log.events.length;
}

function replayValidEvents(events: StateEvent[]): StateEvent[] {
  const valid: StateEvent[] = [];
  for (const event of events) {
    const previous = valid.at(-1);
    if (!previous) {
      if (event.from === null && event.to === 'intake') valid.push(event);
      continue;
    }
    if (event.from === previous.to && isReplayableTransition(previous.to, event.to)) valid.push(event);
  }
  return valid;
}

async function writeCurrentStatePointer(root: string, taskId: string, activeSession: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(activeSessionPath(root), `${JSON.stringify({ taskId, activeSession }, null, 2)}\n`, 'utf8');
}

function activeSessionPath(root: string): string {
  return join(runtimeDir(root), 'active-session.json');
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
