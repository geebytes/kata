import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readValidated, readValidatedOptional, validate } from './schema.js';
import { assertDistillGates as assertDistillGatesFromRecords } from '../workflow/distill-gates.js';
import type { RepairPayload, RepairRecordShape } from '../quality/repair.js';
import { assertValidTaskId } from './ids.js';
import { currentStatePath as layoutCurrentStatePath, stateEventsPath as layoutStateEventsPath, repairPath, taskPath, transitionLockPath } from './layout.js';

export const orderedPhases = [
    'intake',
    'plan',
    'implement',
    'hardVerify',
    'review',
    'judge',
    'distill',
    'archive',
] as const;

export type Phase = (typeof orderedPhases)[number];

export interface Actor {
    id: string;
    role: string;
    platform?: string;
}

export interface TransitionOptions {
    root?: string;
    activeSession?: string;
}

export interface StateRecord {
    taskId: string;
    phase: Phase;
    actor: Actor;
    updatedAt: string;
    activeSession?: string;
}

export interface StateEvent {
    taskId: string;
    from: Phase | null;
    to: Phase;
    actor: Actor;
    at: string;
    activeSession?: string;
}

interface TaskRecordOnDisk {
    id: string;
    acceptance?: Array<{ id?: string; statement?: string }>;
}

export function isLegalPhaseTransition(from: Phase, to: Phase): boolean {
    return orderedPhases.indexOf(to) === orderedPhases.indexOf(from) + 1;
}

/**
 * Repair entrypoints (verify/review/judge repair) deliberately return to `implement`
 * from a later phase. Those backward links bypass `transition()`, so the state
 * event log records them directly and the replay must accept them as chain links —
 * otherwise recovery truncates the chain and rewinds the task to the phase it was
 * repaired from.
 */
export const repairReturnPhases = ['hardVerify', 'review', 'judge'] as const satisfies readonly Phase[];

export function isRepairReturn(from: Phase, to: Phase): boolean {
    return to === 'implement' && (repairReturnPhases as readonly Phase[]).includes(from);
}

/** Chain link accepted by recovery: a normal forward step or a repair return. */
export function isReplayableTransition(from: Phase, to: Phase): boolean {
    return isLegalPhaseTransition(from, to) || isRepairReturn(from, to);
}

export async function transition(
    taskId: string,
    to: Phase,
    actor: Actor,
    options: TransitionOptions = {},
): Promise<StateRecord> {
    const root = options.root ?? process.cwd();
    assertValidTaskId(taskId);
    return withTaskLock(root, taskId, async () => {
        const current = await readCurrentState(root, taskId);

        if (!isLegalPhaseTransition(current.phase, to)) {
            throw new Error(`Illegal transition from ${current.phase} to ${to}`);
        }
        if (to === 'implement') await assertAcceptanceIds(root, taskId);
        if (to === 'distill') await assertDistillGates(root, taskId);

        const now = new Date().toISOString();
        const next: StateRecord = {
            taskId,
            phase: to,
            actor,
            updatedAt: now,
            ...(options.activeSession ? { activeSession: options.activeSession } : {}),
        };

        await appendStateEvent(root, {
            taskId,
            from: current.phase,
            to,
            actor,
            at: now,
            ...(options.activeSession ? { activeSession: options.activeSession } : {}),
        });
        await writeCurrentState(root, next);

        return next;
    });
}

/**
 * The one way a task re-enters implementation from a gate.
 *
 * Repair entries are the only backward links the state machine accepts, and they used to be maintained by hand in three
 * places: each gate's authorization function appended the event, rewrote the current state and wrote `repair.json`
 * itself. This is that work in one place, driven by the authorization verdict `workflow/repair-entry.ts` returns.
 */
export async function transitionForRepair(input: {
    taskId: string;
    actor: Actor;
    entryPhase: Extract<Phase, 'hardVerify' | 'review' | 'judge'>;
    /** The repair record to persist, or `null` when the entry carries nothing to record. */
    repair: RepairPayload | null;
    root?: string;
}): Promise<StateRecord> {
    const root = input.root ?? process.cwd();
    assertValidTaskId(input.taskId);
    return withTaskLock(root, input.taskId, async () => {
        const current = await readCurrentState(root, input.taskId);
        if (current.phase !== input.entryPhase) {
            throw new Error(`Repair entry expects ${input.taskId} to be in ${input.entryPhase}, but it is in ${current.phase}`);
        }
        if (!isRepairReturn(current.phase, 'implement')) {
            throw new Error(`Illegal repair return from ${current.phase} to implement`);
        }

        const now = new Date().toISOString();
        const next: StateRecord = { taskId: input.taskId, phase: 'implement', actor: input.actor, updatedAt: now };

        await appendStateEvent(root, { taskId: input.taskId, from: current.phase, to: 'implement', actor: input.actor, at: now });
        await writeCurrentState(root, next);

        if (input.repair) {
            const record: RepairRecordShape = {
                ...input.repair,
                fromPhase: input.repair.fromPhase ?? input.entryPhase,
                taskId: input.taskId,
                toPhase: 'implement',
                actor: input.actor,
                createdAt: now,
            };
            await writeFile(repairPath(root, input.taskId), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
        }

        return next;
    });
}

/** Serialize a task mutation across local processes; a conflicting command fails closed. */
export async function withTaskLock<T>(root: string, taskId: string, action: () => Promise<T>): Promise<T> {
    assertValidTaskId(taskId);
    const lockPath = transitionLockPath(root, taskId);
    try {
        await mkdir(lockPath);
    } catch (error) {
        if (isNodeError(error) && error.code === 'EEXIST') {
            throw new Error(`Task ${taskId} already has a state transition in progress`);
        }
        throw error;
    }
    try {
        return await action();
    } finally {
        await rm(lockPath, { recursive: true, force: true });
    }
}

export async function appendStateEvent(root: string, event: StateEvent): Promise<void> {
    // The event log is replayed by recovery, so every append must be a chain link it
    // can accept: the opening intake event, a normal forward step, or a recognized
    // repair return. Rejecting anything else here keeps the log replayable instead of
    // silently rewinding a task's phase later.
    if (event.from === null) {
        if (event.to !== 'intake') {
            throw new Error(`Illegal opening state event: ${event.to}`);
        }
    } else if (!isReplayableTransition(event.from, event.to)) {
        throw new Error(
            `Illegal state event ${event.from} → ${event.to}; extend the replay rules before appending it.`
        );
    }
    await appendFile(layoutStateEventsPath(root, event.taskId), `${JSON.stringify(event)}\n`, 'utf8');
}

export async function writeCurrentState(root: string, state: StateRecord): Promise<void> {
    await writeFileAtomic(layoutCurrentStatePath(root, state.taskId), `${JSON.stringify(state, null, 2)}\n`);
}

export async function readStateEvents(root: string, taskId: string): Promise<StateEvent[]> {
    const raw = await readFile(layoutStateEventsPath(root, taskId), 'utf8');
    return raw
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => validate<StateEvent>('workflow-state-event', JSON.parse(line)));
}

/** The projection every reader should use instead of parsing current-state.json by hand: it is schema-validated. */
export async function readCurrentState(root: string, taskId: string): Promise<StateRecord> {
    return readValidated<StateRecord>('workflow-state-record', layoutCurrentStatePath(root, taskId));
}

async function assertAcceptanceIds(root: string, taskId: string): Promise<void> {
    const task = JSON.parse(await readFile(taskPath(root, taskId), 'utf8')) as TaskRecordOnDisk;
    if (!task.acceptance?.length || task.acceptance.some((criterion) => !/^AC-[0-9]+$/.test(criterion.id ?? ''))) {
        throw new Error('Cannot enter implement until every acceptance criterion has a stable acceptance id');
    }
}

async function assertDistillGates(root: string, taskId: string): Promise<void> {
    // The rules live in workflow/distill-gates.ts: fresh recorded evidence, reviewer clearance, and a Judge pass bound
    // to that same revision and evidence set. The transition asks them instead of deciding them again.
    await assertDistillGatesFromRecords(root, taskId);
}

function currentStatePath(root: string, taskId: string): string {
    assertValidTaskId(taskId);
    return layoutCurrentStatePath(root, taskId);
}

function stateEventsPath(root: string, taskId: string): string {
    assertValidTaskId(taskId);
    return layoutStateEventsPath(root, taskId);
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
    const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporaryPath, content, 'utf8');
    await rename(temporaryPath, path);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error;
}
