import { readTask } from '../core/task.js';
import { readCurrentState } from '../core/state.js';
import { nextActionForTask, readUpstreamSummary, suggestCandidateAction } from '../workflow/navigation.js';
import { computePathDigests, readCurrentTaskRevision, revisionStatus } from '../workflow/revision.js';

/**
 * `kata-cli lane` — **the order of work, made checkable.**
 *
 * Measured, three times in one day, and the sharpest to the minute: a change sealed revision `a118c21c` at 14:24:15 UTC, its round returned an
 * accepted record, review approved — and eleven minutes later a sibling change's repair touched `src/quality/adversarial.ts`, a path this
 * change declares, so judge failed **every** criterion with `stale_evidence`. The certification a change pays a round for has a shelf life,
 * because 38 paths on this repository are declared by more than one change and every repair moves its siblings' revisions.
 *
 * Nothing in the workflow said so. The ladder presents a change climbing alone, while correctness depends on a **global ordering** the operator
 * has to derive from reading `ownedPaths` by hand — which is how an eleven-minute collision stayed invisible until it cost a round.
 *
 * This command decides the one thing that ordering needs, and decides it from content rather than from a clock:
 *
 *   * **`current`** — the revision hashes exactly the owned paths as they are on disk, so a round dispatched now certifies content that will
 *     still be that content when the seal runs.
 *   * **`declaration-moved`** — the task declares paths the revision does not carry. Re-sealing adopts the new declaration; dispatching now
 *     certifies the old surface.
 *   * **`superseded`** — an owned path's content has changed since the seal. **The window is open**: a round dispatched now is about content no
 *     seal describes, and the seal that fixes it is the seal that voids the record. This is the eleven-minute case, and it is the one the
 *     refusal exists for.
 *
 * `--require-current` turns the report into the guard, so a lane step can refuse rather than trust the operator to look. The command does not
 * *edit* anything and it does not run the cycle — a command that runs the cycle cannot prevent the edit that breaks it, which is why the
 * decision is what is worth building first.
 */
export interface LaneReport {
    [key: string]: unknown;
    command: 'lane';
    taskId: string;
    phase: string;
    nextSkill: string;
    reason: string;
    cliCommand: string;
    revisionId: string | null;
    revisionStatus: string;
    /** The owned paths whose content no longer matches the sealed revision, which is what the operator acts on. */
    driftedPaths: string[];
    /** Paths the task declares that the revision does not carry. */
    addedPaths: string[];
    /** Paths the revision carries that the task no longer declares. */
    removedPaths: string[];
    /** True when a step taken now certifies content that a later seal will not change. */
    laneOpen: boolean;
    /** The sentence an operator reads when it is not, or null when it is. */
    blocking: string | null;
    success: boolean;
}

export async function runLaneCommand(change: string, root: string, options?: { requireCurrent?: boolean }): Promise<LaneReport> {
    const task = await readTask(root, change).catch(() => null);
    const state = await readCurrentState(root, change).catch(() => null);
    if (!task || !state) {
        return {
            command: 'lane',
            taskId: change,
            phase: '(unknown)',
            nextSkill: '(unknown)',
            reason: '(unknown)',
            cliCommand: '(unknown)',
            revisionId: null,
            revisionStatus: 'no_task',
            driftedPaths: [],
            addedPaths: [],
            removedPaths: [],
            laneOpen: false,
            blocking: `No task named '${change}' is readable from this workspace.`,
            success: false,
        };
    }
    const upstream = await readUpstreamSummary(root, change);
    const suggestion = suggestCandidateAction(state.phase, upstream);
    const next = nextActionForTask(change, suggestion.nextSkill, suggestion.role, suggestion.reason);

    const revision = await readCurrentTaskRevision(root, change).catch(() => null);
    if (!revision) {
        return {
            command: 'lane',
            taskId: change,
            phase: state.phase,
            nextSkill: suggestion.nextSkill,
            reason: suggestion.reason,
            cliCommand: next.cliCommand,
            revisionId: null,
            revisionStatus: 'no_revision',
            driftedPaths: [],
            addedPaths: [],
            removedPaths: [],
            laneOpen: false,
            blocking: 'No revision is sealed, so there is nothing for a round to certify — seal first (`kata-cli build --seal`).',
            success: !options?.requireCurrent,
        };
    }

    const status = await revisionStatus(root, revision, change);
    // The drifted paths come from the same comparison the status makes, reported as names because "superseded" is a verdict and the
    // operator's next action is to look at a file. Content, not mtime: a touch that changes nothing is not drift, and this repository's
    // working tree changes constantly.
    const drifted = status.status === 'superseded'
        ? (await driftPaths(root, revision)).sort()
        : [];
    const laneOpen = status.status === 'current';
    const blocking = laneOpen
        ? null
        : status.status === 'superseded'
            ? `An owned path changed after the seal, so a round dispatched now would be about content no seal describes, and the re-seal that `
                + `fixes it is the re-seal that voids the record. Re-seal, then dispatch. Drifted: ${drifted.join(', ') || '(the manifest moved)'}.`
            : `The task declares paths this revision does not carry, so a round now certifies the old surface. Re-seal so the next revision `
                + `covers the declaration, then dispatch.`
        + '';

    return {
        command: 'lane',
        taskId: change,
        phase: state.phase,
        nextSkill: suggestion.nextSkill,
        reason: suggestion.reason,
        cliCommand: next.cliCommand,
        revisionId: revision.id,
        revisionStatus: status.status,
        driftedPaths: drifted,
        addedPaths: status.status === 'declaration-moved' ? status.added : [],
        removedPaths: status.status === 'declaration-moved' ? status.removed : [],
        laneOpen,
        blocking,
        // `--require-current` is the guard form: it exists so a lane step can refuse rather than trust the operator to look.
        success: options?.requireCurrent ? laneOpen : true,
    };
}

/** The owned paths whose content differs from the sealed revision's digests — the names the operator acts on. */
async function driftPaths(root: string, revision: { ownedPaths: string[]; pathDigests?: Record<string, string> }): Promise<string[]> {
    const fresh = await computePathDigests(root, revision.ownedPaths);
    const sealed = revision.pathDigests ?? {};
    return Object.keys(sealed).filter((path) => fresh[path] !== sealed[path]);
}
