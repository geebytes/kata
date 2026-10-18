import { reviewRequestPath } from '../core/layout.js';
import { readRecordState } from '../core/record-read.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readCurrentStateOr } from '../core/state.js';
import { assertValidTaskId } from '../core/ids.js';
import { computeManifestHash, readCurrentTaskRevisionState } from './revision.js';

/**
 * **What has to be true before a reviewer is spent — checked for free, not discovered after the round.**
 *
 * Measured: a round was dispatched, read for nineteen minutes and answered, and *then* refused because the result did not
 * echo the `requestId` and did not answer for every finding in the batch. The reviewer's work was correct; the brief it was
 * handed was incomplete, and nothing before the dispatch could say so. That is a pure waste of the most expensive step in
 * the workflow, and it is mechanical: the fields the recorder will demand are already known, because the recorder reads
 * them from the same document this module reads.
 *
 * So this is not another reviewer and not another gate. It is one derivation with two outputs:
 *
 * - **blockers** — states where dispatching is already known to be pointless (the brief answers another revision, the tree
 *   the reviewer would read is no longer the tree that was frozen, the paths it names do not exist).
 * - **handoff** — the machine-readable list of what the round must be handed and what its result must carry, taken from the
 *   persisted brief rather than from anybody's memory. The batch's finding ids are the measured case: a follow-up that is
 *   not told which findings it owes a verdict for cannot close them, and the recorder refuses the result.
 *
 * **It runs before any gate is consumed and consumes nothing.** A preflight that cost the boundary it protects would be the
 * deadlock this repository has already paid for twice (an approved gate spent on an invocation that refused).
 */

export type ReviewPreflightBlocker = {
    code: string;
    message: string;
    /** A command that runs from here and clears this, or `null` when only a person can act. */
    road: string | null;
};

export type ReviewHandoff = {
    requestId: string;
    reviewKind: string;
    subjectRevision: string;
    /** The fields the returned result must echo, in the recorder's own words. */
    mustEcho: string[];
    /** One entry per batch finding: the result owes a `batchClosure` verdict for each. */
    batchClosureIds: string[];
    /** The surface the reviewer reads, when the brief declares one. */
    declaredPaths: string[];
    probeCount: number;
};

export type ReviewPreflight = {
    ok: boolean;
    taskId: string;
    /**
     * Whether a brief was there to check at all.
     *
     * The caller needs this to tell two refusals apart: a task that has not run `ledger run` yet is *between* steps (the
     * phase entry has nothing to hand over and must not be refused for it), while a task holding a brief that fails this
     * check would spend a reviewer on a question that cannot be answered.
     */
    briefState: 'absent' | 'usable' | 'unreadable';
    blockers: ReviewPreflightBlocker[];
    handoff: ReviewHandoff | null;
};

/** The brief `ledger run` persists, as far as this check reads it. */
type PersistedBrief = {
    requestId?: unknown;
    reviewKind?: unknown;
    subjectRevision?: unknown;
    repairBatch?: { findings?: Array<{ id?: unknown }> };
    probes?: unknown;
    reviewPackage?: { declaration?: { ownedPaths?: unknown } };
};

const REVIEWABLE_PHASES = ['hardVerify', 'review'];

function blocker(code: string, message: string, road: string | null): ReviewPreflightBlocker {
    return { code, message, road };
}

/**
 * The one preflight. Pure in shape: it reads, it never writes, and it never touches a gate or a phase.
 */
export async function collectReviewPreflight(input: { root: string; taskId: string }): Promise<ReviewPreflight> {
    const { root, taskId } = input;
    assertValidTaskId(taskId);
    const blockers: ReviewPreflightBlocker[] = [];
    const ledgerRoad = `kata-cli ledger run --change ${taskId}`;
    const statusRoad = `kata-cli status --change ${taskId}`;

    const stateRead = await readCurrentStateOr(root, taskId);
    const phase = stateRead.kind === 'current' ? stateRead.state.phase : null;
    if (stateRead.kind === 'unreadable') {
        blockers.push(blocker('state_unreadable', `The task's phase record could not be read (${stateRead.reason}), so whether a round can be dispatched here is unknown.`, statusRoad));
    } else if (phase === null || !REVIEWABLE_PHASES.includes(phase)) {
        blockers.push(blocker('phase_not_reviewable', `A round can only be dispatched from hardVerify or review; this task is at '${phase ?? 'unknown'}'.`, statusRoad));
    }

    const revisionRead = await readCurrentTaskRevisionState(root, taskId);
    if (revisionRead.kind === 'unreadable') {
        blockers.push(blocker('current_revision_unreadable', 'The current revision could not be read, so no round can be told which revision it is reviewing.', statusRoad));
    }
    const revision = revisionRead.kind === 'current' ? revisionRead.revision : null;

    // **The tree the reviewer would read, against the tree that was frozen.** A round that reads a moved tree judges content
    // nobody sealed — the class an earlier round found when a case drove a prebuilt bundle and judged another revision.
    if (revision) {
        try {
            const live = await computeManifestHash(root, revision.ownedPaths);
            if (live !== revision.manifestHash) {
                blockers.push(blocker(
                    'working_tree_moved',
                    `The declared surface no longer hashes to the frozen revision '${revision.id}': a round dispatched now would read content nobody sealed.`,
                    `kata-cli build --change ${taskId} --seal`,
                ));
            }
        } catch (error) {
            blockers.push(blocker('working_tree_unreadable', `The declared surface could not be hashed (${error instanceof Error ? error.message : String(error)}), so it cannot be shown to match the frozen revision.`, statusRoad));
        }
    }

    const briefRead = await readRecordState<PersistedBrief>(reviewRequestPath(root, taskId));
    if (briefRead.kind === 'absent') {
        blockers.push(blocker('brief_missing', 'No review request has been persisted, so there is nothing to hand a reviewer and nothing to check.', ledgerRoad));
        return { ok: false, taskId, briefState: 'absent', blockers, handoff: null };
    }
    if (briefRead.kind === 'unreadable') {
        blockers.push(blocker('brief_unreadable', `The persisted review request could not be read (${briefRead.detail}), so what the round must answer is unknown.`, ledgerRoad));
        return { ok: false, taskId, briefState: 'unreadable', blockers, handoff: null };
    }

    const brief = briefRead.value;
    const requestId = typeof brief.requestId === 'string' && brief.requestId.trim() !== '' ? brief.requestId : null;
    const reviewKind = typeof brief.reviewKind === 'string' && brief.reviewKind.trim() !== '' ? brief.reviewKind : null;
    const subjectRevision = typeof brief.subjectRevision === 'string' && brief.subjectRevision.trim() !== '' ? brief.subjectRevision : null;

    if (requestId === null) {
        blockers.push(blocker('brief_without_request_id', 'The persisted request carries no requestId, and the recorder refuses a result that cannot echo the brief it answered.', ledgerRoad));
    }
    if (reviewKind === null) {
        blockers.push(blocker('brief_without_review_kind', 'The persisted request carries no reviewKind, so a round cannot be told which of the three activities it is.', ledgerRoad));
    }
    if (subjectRevision === null) {
        blockers.push(blocker('brief_without_subject', 'The persisted request names no subject revision, so a round cannot be told what it is reviewing.', ledgerRoad));
    } else if (revision !== null && subjectRevision !== revision.id) {
        blockers.push(blocker(
            'brief_answers_another_revision',
            `The persisted request speaks for revision '${subjectRevision}', but the task now stands at '${revision.id}': the round would answer a question about content that is no longer current.`,
            ledgerRoad,
        ));
    }

    // **The batch is the object a follow-up was missing**, and the recorder demands a verdict per finding: a follow-up
    // dispatched without its ids is the measured waste (a correct round refused for not answering a list it never saw).
    const batchClosureIds = (brief.repairBatch?.findings ?? [])
        .map((finding) => finding?.id)
        .filter((id): id is string => typeof id === 'string');
    if (reviewKind === 'focused_followup' && batchClosureIds.length === 0) {
        blockers.push(blocker('followup_without_batch', 'This round is a focused follow-up but the request carries no batch findings, so it has nothing to verify and nothing to close.', ledgerRoad));
    }

    const declaredPaths = Array.isArray(brief.reviewPackage?.declaration?.ownedPaths)
        ? (brief.reviewPackage?.declaration?.ownedPaths as unknown[]).filter((path): path is string => typeof path === 'string')
        : [];
    const missingPaths = declaredPaths.filter((path) => !existsSync(join(root, path)));
    if (missingPaths.length > 0) {
        blockers.push(blocker(
            'brief_names_missing_paths',
            `The request's declared surface names ${missingPaths.length} path(s) that do not exist here: ${missingPaths.join(', ')}.`,
            `kata-cli scope show --change ${taskId}`,
        ));
    }

    const probes = Array.isArray(brief.probes) ? brief.probes as Array<{ id?: unknown; command?: unknown }> : [];
    const emptyProbes = probes.filter((probe) => typeof probe?.command !== 'string' || probe.command.trim() === '');
    if (emptyProbes.length > 0) {
        blockers.push(blocker('probe_without_command', `${emptyProbes.length} probe(s) carry no command, so a reviewer is asked a question with no way to answer it.`, ledgerRoad));
    }

    const handoff: ReviewHandoff | null = requestId !== null && reviewKind !== null && subjectRevision !== null
        ? {
            requestId,
            reviewKind,
            subjectRevision,
            // Named from what the recorder reads, so the author's brief to the reviewer is copied rather than remembered.
            mustEcho: [
                'requestId',
                'reviewKind',
                ...(batchClosureIds.length > 0 ? ['batchClosure (one entry per batch finding)'] : []),
            ],
            batchClosureIds,
            declaredPaths,
            probeCount: probes.length,
        }
        : null;

    return { ok: blockers.length === 0, taskId, briefState: 'usable', blockers, handoff };
}
