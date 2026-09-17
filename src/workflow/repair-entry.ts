import { join } from 'node:path';
import { readValidatedOptional } from '../core/schema.js';
import type { Phase } from '../core/state.js';
import type { JudgeAcceptanceResult } from '../quality/judge.js';
import { isRepairableScope, repairableJudgeScopes, repairableVerifyScopes, type RepairScope } from '../quality/judge.js';
import type { RepairPayload } from '../quality/repair.js';
import { readCurrentTaskRevision, revisionStatus } from './revision.js';

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
async function revisionSuperseded(root: string, taskId: string): Promise<{ id: string; manifestHash: string } | null> {
    const revision = await readCurrentTaskRevision(root, taskId);
    if (!revision) return null;
    return (await revisionStatus(root, revision)).status === 'superseded' ? revision : null;
}

/** hardVerify: a verify FAIL whose failed acceptance scopes are all repairable, or a re-seal of a stale verdict. */
export async function authorizeVerifyRepair(root: string, taskId: string): Promise<RepairAuthorization> {
    const entryPhase: RepairEntryPhase = 'hardVerify';
    // An absent verdict means there is nothing to repair against; a drifted one is an error, not an absence.
    const verify = await readValidatedOptional<{ result?: string; acceptance?: JudgeAcceptanceResult[] }>(
        'verify-result',
        join(root, '.kata/tasks', taskId, 'verify.json'),
    );
    if (!verify) {
        // No verify verdict to repair against: the entry is recorded by the state transition alone.
        return { authorized: true, entryPhase, repair: null };
    }

    const failedAcceptance = (verify.acceptance ?? []).filter((criterion) => criterion.result === 'FAIL');
    const isRepairable = verify.result === 'FAIL'
        && (failedAcceptance.length === 0
            || failedAcceptance.every((criterion) => isRepairableScope(criterion.repairScope, repairableVerifyScopes)));
    if (!isRepairable) {
        return denial(entryPhase, 'Build cannot run from hardVerify without a repairable verify FAIL result');
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
    const review = await readValidatedOptional<{
        revisionId?: string;
        findings?: Array<{ id?: string; acceptanceId?: string; severity?: string; message?: string; path?: string }>;
    }>('review', join(root, '.kata/tasks', taskId, 'review.json'));
    if (!review) {
        return denial(entryPhase, 'Build cannot run from review without a recorded review. Run /kata-review first.');
    }
    const task = await readValidatedOptional<{ workflowProfile?: { reviewMode?: string } }>('task', join(root, '.kata/tasks', taskId, 'task.json'))
        .catch(() => null);
    const isStrict = task?.workflowProfile?.reviewMode === 'strict';
    const revision = await readCurrentTaskRevision(root, taskId);
    if (review.revisionId !== revision?.id) {
        return denial(entryPhase, 'Build cannot run from review because its findings are not bound to the current sealed revision. Re-run /kata-review.');
    }

    const findings = review.findings ?? [];
    const blockingFindings = findings.filter((finding) => finding.severity === 'blocking');
    const majorFindings = isStrict ? findings.filter((finding) => finding.severity === 'major') : [];
    const severityAuthorized = blockingFindings.length + majorFindings.length > 0;
    // Evidence drift authorises re-entry too: once the sealed revision is superseded the evidence cannot describe the
    // current implementation, and the only alternative would be judging with stale evidence. A new revision invalidates
    // the review binding, so the task still has to seal, verify and be reviewed again.
    const superseded = (await revisionSuperseded(root, taskId)) !== null;
    if (!severityAuthorized && !superseded) {
        return denial(entryPhase, 'Build cannot run from review without blocking (or strict-mode major) review findings, or a superseded sealed revision. Re-running /kata-review first ensures a fresh evaluation against the current sealed revision.');
    }

    const repairFindings = severityAuthorized ? [...blockingFindings, ...majorFindings] : findings;
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
        join(root, '.kata/tasks', taskId, 'judge.json'),
    );
    if (!judge) {
        return denial(entryPhase, 'Build cannot run from judge without a recorded judge result. Run /kata-judge first.');
    }

    const failedAcceptance = (judge.acceptance ?? []).filter((criterion) => criterion.result === 'FAIL');
    const judgeRepairable = judge.result === 'FAIL'
        && failedAcceptance.length > 0
        && failedAcceptance.every((criterion) => isRepairableScope(criterion.repairScope, repairableJudgeScopes));
    const supersededRecord = judgeRepairable ? null : await revisionSuperseded(root, taskId);
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
