import { join } from 'node:path';
import { readValidatedOptional } from '../core/schema.js';
import type { Phase } from '../core/state.js';
import type { JudgeAcceptanceResult } from '../quality/judge.js';
import { isRepairableScope, repairableJudgeScopes, repairableVerifyScopes, type RepairScope } from '../quality/judge.js';
import { appendReviewRound, type RepairPayload } from '../quality/repair.js';
import { readCurrentTaskRevision, revisionIsCurrent, revisionStatus } from './revision.js';
import { bindsToRevision, currentRevisionIdentity } from './verdict-binding.js';
import { verifyPath, reviewPath, judgePath } from '../core/layout.js';
import { readBlockingProblems } from './review-read.js';
import { mergeBlockingSeverities, reviewTierFor } from '../quality/review-ladder.js';

/**
 * Whether a task may leave a gate and re-enter implementation, and what that entry is recorded as.
 *
 * The three gates used to answer this in three separate functions that each read their own artefact, decided their own
 * authorization, appended the state event, rewrote the current state and wrote `repair.json` — and had already drifted
 * (the verify copy authorised `revision_superseded`, the judge copy did not, until drift deadlocked it). This module
 * holds the decision once; the transition itself belongs to `state.ts`'s `transitionForRepair`.
 */

export type RepairEntryPhase = Extract<Phase, 'hardVerify' | 'review' | 'judge'>;

export interface RepairAuthorization {
    authorized: boolean;
    entryPhase: RepairEntryPhase;
    /** The repair record to write, or `null` when the entry is a plain re-entry with nothing to record. */
    repair: RepairPayload | null;
    /** The user-facing reason a gate refuses to re-enter, when it does. */
    denial?: string;
}

function denial(entryPhase: RepairEntryPhase, message: string): RepairAuthorization {
    return { authorized: false, entryPhase, repair: null, denial: message };
}

/** Fresh evidence after sealing supersedes the revision the verdict was bound to. */
/**
 * A sealed revision that no longer describes what it is asked about, in **either** of the two ways it can stop.
 *
 * **`declaration-moved` counts, and that is the fix.** The check used to ask only `superseded` — whether the content it
 * described had changed — and hashed `revision.ownedPaths`, so a task whose declaration grew afterwards (this change: 11 paths to
 * 23, via `scope change` + `scope apply`) read as current while twelve declared paths had never been hashed. `repair-entry.ts`
 * then refused a seal with "the sealed revision still matches the workspace", a claim about the workspace decided from the older
 * declaration — and the seal it refused is the only thing that can take on the newer one.
 */
async function revisionNoLongerDescribes(root: string, taskId: string): Promise<{ id: string; manifestHash: string } | null> {
    const revision = await readCurrentTaskRevision(root, taskId);
    if (!revision) return null;
    const status = await revisionStatus(root, revision, taskId);
    return revisionIsCurrent(status) ? null : revision;
}

/** hardVerify: a verify FAIL whose failed acceptance scopes are all repairable, or a re-seal of a stale verdict. */
export async function authorizeVerifyRepair(root: string, taskId: string): Promise<RepairAuthorization> {
    const entryPhase: RepairEntryPhase = 'hardVerify';
    // An absent verdict means there is nothing to repair against; a drifted one is an error, not an absence.
    const verify = await readValidatedOptional<{ result?: string; acceptance?: JudgeAcceptanceResult[] }>(
        'verify-result',
        verifyPath(root, taskId),
    );
    if (!verify) {
        // No verify verdict to repair against: the entry is recorded by the state transition alone.
        return { authorized: true, entryPhase, repair: null };
    }

    // Evidence drift authorises re-entry here for the same reason it does at review: once the sealed revision is
    // superseded, the recorded verdict cannot describe the current implementation, and the only alternative is to judge
    // with evidence that no longer matches. Without this the task had to run a verify it knew would FAIL merely to have
    // the phase moved back — a whole round-trip per re-seal, and the same "authorised but unrecognised" shape as the
    // review and judge deadlocks.
    if (await revisionNoLongerDescribes(root, taskId)) {
        return {
            authorized: true,
            entryPhase,
            repair: { fromPhase: entryPhase, reason: 'revision_superseded', scopes: [] },
        };
    }

    const failedAcceptance = (verify.acceptance ?? []).filter((criterion) => criterion.result === 'FAIL');
    const isRepairable = verify.result === 'FAIL'
        && (failedAcceptance.length === 0
            || failedAcceptance.every((criterion) => isRepairableScope(criterion.repairScope, repairableVerifyScopes)));
    if (!isRepairable) {
        return denial(
            entryPhase,
            // **The message says what was checked, which is the declaration — not the workspace** (rba7-a4e3edc4, cg4-f2).
            // It read "the sealed revision still matches the workspace", but the only freshness check behind it hashes
            // `revision.ownedPaths`, so a workspace changed outside that declared set reads as current and the sentence was
            // false about the working tree. The claim is withdrawn rather than re-worded: `revisionStatus` answers the
            // declaration question, and claiming more than it answered is the class this change exists to remove. The
            // unsettled part — whether the workspace outside the declaration has moved — is reported to the operator as
            // `kata-cli verify`, which reads it, rather than asserted here.
            'Build cannot run from hardVerify without a repairable verify FAIL result, and the sealed revision\'s declared '
            + 'manifest is unchanged (a change outside its owned paths is not seen by this check). Run '
            + '`kata-cli verify --change <task>` to record what is missing, or make the change the verdict asks for.',
        );
    }

    return {
        authorized: true,
        entryPhase,
        repair: {
            fromPhase: entryPhase,
            reason: failedAcceptance.length === 0 ? 'verify_reseal' : 'verify_fail',
            scopes: failedAcceptance.map((criterion) => ({ id: criterion.id, repairScope: criterion.repairScope as RepairScope })),
        },
    };
}

/** review: blocking findings (or strict-mode major ones), or a superseded sealed revision. */
export async function authorizeReviewRepair(root: string, taskId: string): Promise<RepairAuthorization> {
    const entryPhase: RepairEntryPhase = 'review';
    // **The record is read once, by the reader, and this entry adds no read of its own.** It used to open `review.json`
    // with a validating read *before* asking the reader, so a record that did not match its schema threw out of the repair
    // entry while the gate refused the same record — one malformed file, two behaviours, and the crash was the one an
    // operator would see. The reader's answer carries everything this entry needs: the mode, the problems, whether the
    // record describes the current content, and the findings themselves.
    const blockingRead = await readBlockingProblems(root, taskId);
    if (!blockingRead.ok) {
        return denial(entryPhase, `Build cannot run from review because the recorded review cannot be read as one: ${blockingRead.why}`);
    }
    const reviewMode = blockingRead.mode;
    const findings = [...blockingRead.findings];
    const blockingProblems = blockingRead.problems;
    // **After the reader, and guarded.** The baseline revision is named in the repair record, so it is read only once the
    // entry has decided to authorise — and a revision file that cannot be read refuses here rather than throwing out of a
    // gate. The reader above has already established that the review itself is readable, which is what a corrupt
    // revision file would otherwise have prevented anyone from discovering.
    let revision = null;
    try {
        revision = await readCurrentTaskRevision(root, taskId);
    } catch (error) {
        return denial(entryPhase, `Build cannot run from review because the sealed revision cannot be read (${(error as Error).message}).`);
    }
    if (!blockingRead.exists) {
        return denial(entryPhase, 'Build cannot run from review without a recorded review. Run /kata-review first.');
    }
    if (!blockingRead.boundToCurrentRevision) {
        return denial(
            entryPhase,
            'Build cannot run from review because its findings are not bound to the current sealed revision (or to the same '
            + 'content under a new revision). Re-run /kata-review.',
        );
    }
    const severityAuthorized = blockingProblems.length > 0;
    // Evidence drift authorises re-entry too: once the sealed revision is superseded the evidence cannot describe the
    // current implementation, and the only alternative would be judging with stale evidence. A new revision invalidates
    // the review binding, so the task still has to seal, verify and be reviewed again.
    const superseded = (await revisionNoLongerDescribes(root, taskId)) !== null;
    if (!severityAuthorized && !superseded) {
        return denial(
            entryPhase,
            `Build cannot run from review without a problem the ${reviewTierFor(reviewMode)} ladder blocks on (${mergeBlockingSeverities(reviewMode).join(', ')}) and none has been disposed of, or a superseded sealed revision. Re-running /kata-review first ensures a fresh evaluation against the current sealed revision.`,
        );
    }

    // Both shapes are mapped to the record's own shape, so the payload that reaches `repair.json` does not depend on
    // which source named the problem — a ledger claim has no `path`, and a legacy finding has no statement.
    const repairFindings: Array<{ id: string; severity: string; message: string; acceptanceId?: string; path?: string }> = severityAuthorized
        ? blockingProblems.map((problem) => ({ id: problem.id, severity: problem.severity, message: problem.message }))
        : findings.map((finding) => ({
            id: finding.id ?? '',
            severity: finding.severity ?? '',
            message: finding.message ?? '',
            ...(finding.acceptanceId ? { acceptanceId: finding.acceptanceId } : {}),
            ...(finding.path ? { path: finding.path } : {}),
        }));
    // **The round is recorded before it is entered**, and only when it is entered: this is the fact the escalation reads to
    // decide whether the loop is moving. A repair opened because the revision was superseded has no count to record, and
    // says so with `null` rather than with a zero that would read as progress.
    await appendReviewRound(root, taskId, {
        at: new Date().toISOString(),
        blockingIds: blockingProblems.map((problem) => problem.id),
        blockingCount: severityAuthorized ? blockingProblems.length : null,
    });
    return {
        authorized: true,
        entryPhase,
        repair: {
            fromPhase: entryPhase,
            reason: severityAuthorized ? 'review_findings' : 'revision_superseded',
            ...(revision ? { baselineRevisionId: revision.id, baselineManifestHash: revision.manifestHash } : {}),
            findings: repairFindings.map((finding) => ({
                id: finding.id,
                ...(finding.acceptanceId ? { acceptanceId: finding.acceptanceId } : {}),
                severity: finding.severity,
                message: finding.message,
                ...(finding.path ? { path: finding.path } : {}),
            })),
        },
    };
}

/** judge: a judge FAIL with repairable scopes, or a superseded sealed revision. */
export async function authorizeJudgeRepair(root: string, taskId: string): Promise<RepairAuthorization> {
    const entryPhase: RepairEntryPhase = 'judge';
    const judge = await readValidatedOptional<{ result?: string; acceptance?: JudgeAcceptanceResult[] }>(
        'judge-result',
        judgePath(root, taskId),
    );
    if (!judge) {
        return denial(entryPhase, 'Build cannot run from judge without a recorded judge result. Run /kata-judge first.');
    }

    const failedAcceptance = (judge.acceptance ?? []).filter((criterion) => criterion.result === 'FAIL');
    const judgeRepairable = judge.result === 'FAIL'
        && failedAcceptance.length > 0
        && failedAcceptance.every((criterion) => isRepairableScope(criterion.repairScope, repairableJudgeScopes));
    const supersededRecord = judgeRepairable ? null : await revisionNoLongerDescribes(root, taskId);
    if (!judgeRepairable && !supersededRecord) {
        return denial(entryPhase, 'Build cannot run from judge without a repairable judge FAIL result, or a superseded sealed revision');
    }

    return {
        authorized: true,
        entryPhase,
        repair: {
            fromPhase: entryPhase,
            reason: judgeRepairable ? 'judge_fail' : 'revision_superseded',
            // Drift authorisation records the baseline it supersedes, so the repair proves which revision it replaced —
            // and the seal path's "the manifest must have changed" check has something to compare against.
            ...(judgeRepairable
                ? {}
                : { baselineRevisionId: supersededRecord!.id, baselineManifestHash: supersededRecord!.manifestHash }),
            scopes: failedAcceptance.map((criterion) => ({ id: criterion.id, repairScope: criterion.repairScope as RepairScope })),
        },
    };
}

const authorizers: Record<RepairEntryPhase, (root: string, taskId: string) => Promise<RepairAuthorization>> = {
    hardVerify: authorizeVerifyRepair,
    review: authorizeReviewRepair,
    judge: authorizeJudgeRepair,
};

/** The one entry point: what does leaving this phase to re-enter implementation require? */
export async function authorizeRepair(entryPhase: RepairEntryPhase, root: string, taskId: string): Promise<RepairAuthorization> {
    return authorizers[entryPhase](root, taskId);
}
