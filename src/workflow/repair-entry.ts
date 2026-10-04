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
import { ledgerVerdict } from '../store/verdict.js';

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

/** One ledger verdict derivation shared by every gate repair admission. */
export async function ledgerDeficitRepairAdmission(
    root: string,
    taskId: string,
    entryPhase: RepairEntryPhase,
 ): Promise<RepairAuthorization> {
    const ledger = await ledgerVerdict({ root, changeId: taskId });
    if (ledger.kind === 'decided' && ledger.decision.verdict !== 'pass') {
        return {
            authorized: true,
            entryPhase,
            repair: { fromPhase: entryPhase, reason: 'ledger_deficits', scopes: [] },
        };
    }

    const reason = ledger.kind === 'decided'
        ? 'the ledger decides this change passes, so there is no deficit to repair'
        : ledger.kind === 'unreadable'
            ? `the recorded ledger cannot be read (${ledger.detail}), so it decides nothing to repair`
            : 'no ledger has been recorded, so there is no deficit to repair';
    return denial(entryPhase, `The ledger does not authorize repair: ${reason}.`);
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

/**
 * Read a recorded artefact, and turn "it does not match its schema" into a denial.
 *
 * `readValidatedOptional` throws on a mismatch, which is right for a reader and wrong on this path: it let a corrupted
 * `judge.json` travel out of the authoriser, out of `build`, and out of the command as a stack trace — measured, by
 * driving the route the dispatcher returns for a judge FAIL. The caller asked whether a repair is authorized; "the
 * artefact cannot be read" is an answer, and a command that refuses by throwing leaves nothing upstream able to report it.
 */
async function readArtefactOrDenial<T>(
    entryPhase: RepairEntryPhase,
    kind: string,
    path: string,
): Promise<{ ok: true; value: T | null } | { ok: false; denial: RepairAuthorization }> {
    try {
        return { ok: true, value: await readValidatedOptional<T>(kind, path) };
    } catch (error) {
        return {
            ok: false,
            denial: denial(entryPhase, `Build cannot run: the recorded ${kind} cannot be read (${(error as Error).message}). Repair or remove the artefact and run the command that writes it.`),
        };
    }
}

/** hardVerify: a verify FAIL whose failed acceptance scopes are all repairable, or a re-seal of a stale verdict. */
export async function authorizeVerifyRepair(root: string, taskId: string): Promise<RepairAuthorization> {
    const entryPhase: RepairEntryPhase = 'hardVerify';
    // An absent verdict means there is nothing to repair against; a drifted one is an error, not an absence.
    const verifyRead = await readArtefactOrDenial<{ result?: string; acceptance?: JudgeAcceptanceResult[] }>(
        entryPhase,
        'verify-result',
        verifyPath(root, taskId),
    );
    if (!verifyRead.ok) return verifyRead.denial;
    const verify = verifyRead.value;
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
        const ledgerAdmission = await ledgerDeficitRepairAdmission(root, taskId, entryPhase);
        if (ledgerAdmission.authorized) return ledgerAdmission;
        return denial(
            entryPhase,
            [
                'Build cannot run from hardVerify without a repairable verify FAIL result, or a ledger that asks for a repair.',
                ledgerAdmission.denial,
                "The sealed revision's declared manifest is unchanged (a change outside its owned paths is not seen by this check).",
                'Run `kata-cli verify --change <task>` to record what is missing, or make the change the verdict asks for.',
            ].filter(Boolean).join(' '),
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
    const reviewBlockingProblems = blockingProblems.filter((problem) => problem.source === 'finding');
    // **After the reader, and unguarded — because the guard here could not fire.** This was a `try/catch` written when the
    // revision reader threw on drift; once it answered `null` instead, the catch became unreachable and the comment beside
    // it claimed a refusal that happened somewhere else entirely (the reader above refuses an unreadable revision, since
    // the review's binding cannot be established without it). Measured: no input reaches this catch. What is honest is the
    // plain read, with the refusal left where it actually is.
    const revision = await readCurrentTaskRevision(root, taskId);
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
    const severityAuthorized = reviewBlockingProblems.length > 0;
    // Evidence drift authorises re-entry too: once the sealed revision is superseded the evidence cannot describe the
    // current implementation, and the only alternative would be judging with stale evidence. A new revision invalidates
    // the review binding, so the task still has to seal, verify and be reviewed again.
    const superseded = (await revisionNoLongerDescribes(root, taskId)) !== null;
    const repairReason = severityAuthorized ? 'review_findings' : superseded ? 'revision_superseded' : 'ledger_deficits';
    if (!severityAuthorized && !superseded) {
        const ledgerAdmission = await ledgerDeficitRepairAdmission(root, taskId, entryPhase);
        if (!ledgerAdmission.authorized) {
            return denial(
                entryPhase,
                [
                    `Build cannot run from review without a problem the ${reviewTierFor(reviewMode)} ladder blocks on (${mergeBlockingSeverities(reviewMode).join(', ')}) and none has been disposed of, or a superseded sealed revision.`,
                    ledgerAdmission.denial,
                    'Re-running /kata-review first ensures a fresh evaluation against the current sealed revision.',
                ].filter(Boolean).join(' '),
            );
        }
    }

    // Claim-only ledger repair carries no review findings. A superseded revision retains its
    // current review findings for voluntary repair; only a real review finding selects `review_findings`.
    const repairFindings: Array<{ id: string; severity: string; message: string; acceptanceId?: string; path?: string }> = severityAuthorized
        ? reviewBlockingProblems.map((problem) => ({ id: problem.id, severity: problem.severity, message: problem.message }))
        : superseded
            ? findings.map((finding) => ({
                id: finding.id ?? '',
                severity: finding.severity ?? '',
                message: finding.message ?? '',
                ...(finding.acceptanceId ? { acceptanceId: finding.acceptanceId } : {}),
                ...(finding.path ? { path: finding.path } : {}),
            }))
            : [];
    // **The round is recorded before it is entered**, and only when it is entered: this is the fact the escalation reads to
    // decide whether the loop is moving. A repair opened because the revision was superseded has no count to record, and
    // says so with `null` rather than with a zero that would read as progress.
    await appendReviewRound(root, taskId, {
        at: new Date().toISOString(),
        blockingIds: reviewBlockingProblems.map((problem) => problem.id),
        blockingCount: severityAuthorized ? reviewBlockingProblems.length : null,
    });
    return {
        authorized: true,
        entryPhase,
        repair: {
            fromPhase: entryPhase,
            reason: repairReason,
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
    const judgeRead = await readArtefactOrDenial<{ result?: string; acceptance?: JudgeAcceptanceResult[] }>(
        entryPhase,
        'judge-result',
        judgePath(root, taskId),
    );
    if (!judgeRead.ok) return judgeRead.denial;
    const judge = judgeRead.value;
    if (!judge) {
        return denial(entryPhase, 'Build cannot run from judge without a recorded judge result. Run /kata-judge first.');
    }

    const failedAcceptance = (judge.acceptance ?? []).filter((criterion) => criterion.result === 'FAIL');
    const judgeRepairable = judge.result === 'FAIL'
        && failedAcceptance.length > 0
        && failedAcceptance.every((criterion) => isRepairableScope(criterion.repairScope, repairableJudgeScopes));
    const supersededRecord = judgeRepairable ? null : await revisionNoLongerDescribes(root, taskId);
    if (!judgeRepairable && !supersededRecord) {
        const ledgerAdmission = await ledgerDeficitRepairAdmission(root, taskId, entryPhase);
        if (ledgerAdmission.authorized) return ledgerAdmission;
        return denial(
            entryPhase,
            [
                'Build cannot run from judge without a repairable judge FAIL result, or a superseded sealed revision.',
                ledgerAdmission.denial,
            ].filter(Boolean).join(' '),
        );
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
