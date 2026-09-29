import type { EvidenceEnvelope } from '../quality/evidence.js';
import { checkFreshness, computeDiffHash, readRecordedEvidence } from '../quality/evidence.js';
import { readValidatedOptional } from '../core/schema.js';
import { join } from 'node:path';
import { readTaskRevision, revisionIsCurrent, revisionStatus } from './revision.js';
import type { JudgeResult } from '../quality/judge.js';
import { judgePath, reviewPath } from '../core/layout.js';
import { bindsToRevision, currentRevisionIdentity } from './verdict-binding.js';
import { readBlockingProblems, readReviewRecord } from './review-read.js';

/**
 * Whether a task may enter distill.
 *
 * Three conditions have to hold, and this module is the one place each is decided: the task has fresh passing test
 * evidence, the reviewer cleared the change, and the Judge passed it *against that same revision and evidence set*.
 *
 * The gate used to decide all three itself, from a single synthetic file (`.kata/evidence/<taskId>-hard.json`) rather
 * than from the recorded evidence set, and re-derived the Judge's validity rules a third time. It now reads the set the
 * task recorded and asks the rules declared here.
 */

export interface FreshPassingEvidence {
    evidence: EvidenceEnvelope;
    revisionId?: string;
}

/** The recorded, passing test evidence that still describes the current revision (or the current diff). */
export async function freshPassingTestEvidence(
    root: string,
    taskId: string,
    currentDiffHash: string,
): Promise<FreshPassingEvidence | null> {
    const evidence = await readRecordedEvidence(root, taskId);
    for (const envelope of evidence) {
        if (envelope.kind !== 'test' || envelope.exitCode !== 0) continue;
        if (envelope.revisionId) {
            const revision = await readTaskRevision(root, taskId, envelope.revisionId);
            // **The one predicate every consumer asks**, rather than `!== 'current'` spelled out here: a second spelling is
            // what let `orchestrator.ts` keep the two-state question and answer `declaration-moved` differently (rba7-f2).
            // `declaration-moved` is not current: evidence bound to a revision whose surface the task has outgrown cannot be
            // the evidence an archive rests on, and the same answer `superseded` gets for the same reason.
            if (!revisionIsCurrent(await revisionStatus(root, revision, taskId))) continue;
            return { evidence: envelope, revisionId: envelope.revisionId };
        }
        if (checkFreshness(envelope, currentDiffHash).fresh) return { evidence: envelope };
    }
    return null;
}

export interface ReviewClearance {
    cleared: boolean;
    revisionId?: string;
    /**
     * What the approval says it rested on — **read from the record, and the reader `reviewRoute` never had.**
     *
     * The field was written by the approval path and read by nothing, which is how the gate came to fail *open* on one
     * state: `assertDistillGates` refused a ledger it could not read and said nothing about a ledger that was not there,
     * while the approval clearing it named that ledger as its basis. `absent` is legitimate for a change that never used
     * the ledger and a hole for one approved *on* it, and this is the fact that tells the two apart.
     */
    restsOn: 'ledger' | 'adversarial' | 'unstated';
    reason?: 'not_approved' | 'no_review_evidence' | 'blocking_findings' | 'stale_review' | 'unreadable_review';
    /** Why a `unreadable_review` refusal happened: the reader's own sentence, not a re-description of it. */
    detail?: string;
}

/** Reviewer clearance: an approved review, backed by evidence, without blocking findings, for the sealed revision. */
export async function evaluateReviewClearance(
    root: string,
    taskId: string,
    revisionId?: string,
): Promise<ReviewClearance> {
    // **One read, through the reader every other surface uses.** This gate used a validating reader of its own and let
    // its error escape, so a record that did not match its schema produced an *exception* out of a gate — the one thing a
    // gate must never do. It now refuses, and names the reason as the reader's own sentence.
    const read = await readReviewRecord(root, taskId);
    if (!read.ok) return { cleared: false, restsOn: 'unstated', reason: 'unreadable_review', detail: read.why };
    const review = read.record as {
        revisionId?: string;
        manifestHash?: string;
        status?: string;
        reviewEvidence?: string;
        reviewRoute?: string;
    };
    // The route travels with the refusal as well as the clearance: a caller that only learns "not cleared" cannot tell an
    // absent record from a record whose basis is gone.
    const restsOn: ReviewClearance['restsOn'] =
        review?.reviewRoute === 'ledger' ? 'ledger' : review?.reviewRoute === 'adversarial' ? 'adversarial' : 'unstated';
    if (Object.keys(review).length === 0) return { cleared: false, restsOn: 'unstated', reason: 'not_approved' };
    if (review.status !== 'approved') return { cleared: false, restsOn, reason: 'not_approved' };
    if (!review.reviewEvidence?.trim()) return { cleared: false, restsOn, reason: 'no_review_evidence' };
    // **The blocking question, asked of the one reader.** This gate used to answer it with a bare
    // `severity === 'blocking'` that never read the mode, so under `strict` a `major` problem cleared distill while the
    // ladder routing repairs sent the same change back to build — one question, two answers, and the archive resting on
    // the weaker one. It now asks `readBlockingProblems`, which the approval, the repair entry and the router ask too, so
    // there is no call site left that can assemble a different version of the question.
    const blockingRead = await readBlockingProblems(root, taskId);
    if (!blockingRead.ok) {
        // A record that cannot be read is refused, and *named as that* rather than as a blocking finding: the two need
        // different repairs, and the reader used to propagate a schema error out of a gate instead of denying here.
        return { cleared: false, restsOn, reason: 'unreadable_review', detail: blockingRead.why };
    }
    if (blockingRead.problems.length > 0) {
        return { cleared: false, restsOn, reason: 'blocking_findings' };
    }
    // Bound by revision **or** by the content it reviewed: a re-seal of unchanged owned paths issues a new id, and
    // expiring the clearance there is what made a re-seal re-run the whole review.
    if (revisionId && !bindsToRevision(review, { ...(await currentRevisionIdentity(root, taskId)), revisionId })) {
        return { cleared: false, restsOn, reason: 'stale_review' };
    }
    return { cleared: true, restsOn, ...(revisionId ? { revisionId } : {}) };
}

export interface JudgePass {
    passed: boolean;
    revisionId?: string;
    reason?: 'not_passed' | 'no_evidence' | 'failing_acceptance' | 'stale_judgement' | 'evidence_not_accepted';
}

/**
 * The Judge passed this change *against the sealed revision and the evidence that produced it*: its revision binding
 * (or diff hash, for legacy repository-scoped evidence) still matches, every acceptance criterion passed, and the Judge
 * accepted the very evidence the gate is looking at.
 */
export async function evaluateJudgePass(input: {
    root: string;
    taskId: string;
    currentDiffHash: string;
    freshEvidence: FreshPassingEvidence | null;
}): Promise<JudgePass> {
    const judge = await readValidatedOptional<JudgeResult>('judge-result', judgePath(input.root, input.taskId));
    if (!judge || judge.taskId !== input.taskId || judge.result !== 'PASS') return { passed: false, reason: 'not_passed' };
    if (input.freshEvidence?.revisionId) {
        // The id is the revision the fresh evidence was sealed under; the content fields come from the current revision,
        // because a re-seal of unchanged content issues a new id and the content is what a verdict is really about.
        const identity = await currentRevisionIdentity(input.root, input.taskId);
        if (!bindsToRevision(judge, { ...identity, revisionId: input.freshEvidence.revisionId })) {
            return { passed: false, reason: 'stale_judgement' };
        }
    } else if (judge.diffHash !== input.currentDiffHash) {
        return { passed: false, reason: 'stale_judgement' };
    }
    if (!input.freshEvidence) return { passed: false, reason: 'no_evidence' };
    if (!Array.isArray(judge.acceptance) || judge.acceptance.length === 0) return { passed: false, reason: 'failing_acceptance' };
    if (judge.acceptance.some((criterion) => criterion.result !== 'PASS')) return { passed: false, reason: 'failing_acceptance' };

    const accepted = new Set([
        ...(judge.evidenceIds ?? []),
        ...judge.acceptance.flatMap((criterion) => criterion.evidenceIds ?? []),
    ]);
    if (!accepted.has(input.freshEvidence.evidence.id)) return { passed: false, reason: 'evidence_not_accepted' };
    return { passed: true, ...(judge.revisionId ? { revisionId: judge.revisionId } : {}) };
}

export interface DistillGateReport {
    freshEvidence: FreshPassingEvidence | null;
    review: ReviewClearance;
    judge: JudgePass;
    /**
     * What the evidence ledger decides *now*, when the change has one.
     *
     * **Why archive asks again.** Approval was granted against a ledger that passed at the moment of approval, but
     * `evaluateReviewClearance` reads `review.json` — the record that approval wrote — and nothing re-ran the kernel
     * between approval and archive. Everything a ledger is made of is mutable between those two commands: evidence can
     * be replaced (with the verdicts dropped), a verdict can be re-recorded, a new claim can be added. So the same
     * question was being answered from two places, and only the earlier one was asked of the content.
     *
     * `null` means the change has no ledger and is decided by the round-shaped route, which is not an error — but a
     * ledger that exists and cannot be read, or that no longer passes, is a refusal.
     */
    ledger: { state: 'absent' | 'required-but-missing' | 'unreadable' | 'pass' | 'not-pass'; detail: string; reasons: string[] };
}

export async function evaluateDistillGates(root: string, taskId: string): Promise<DistillGateReport> {
    const currentDiffHash = await computeDiffHash(root);
    const freshEvidence = await freshPassingTestEvidence(root, taskId, currentDiffHash);
    const [review, judge] = await Promise.all([
        evaluateReviewClearance(root, taskId, freshEvidence?.revisionId),
        evaluateJudgePass({ root, taskId, currentDiffHash, freshEvidence }),
    ]);
    // The ledger half runs *after* the clearance and is told what it rested on, so there is one reader of the approval's
    // route rather than a second lookup: what the record says its basis was is exactly what decides whether an absent
    // ledger is a legitimate state or a hole.
    const ledger = await evaluateLedgerAtArchive(root, taskId, review.restsOn === 'ledger');

    return { freshEvidence, review, judge, ledger };
}

/**
 * The ledger, re-decided for the archive gate — including the drift check the approval also performs.
 *
 * The drift half is not optional here: a verdict must not outlive the content it was about, and between approval and
 * archive a sibling change can edit a shared path. Asking for the verdict without asking whether it is still about this
 * content would certify a decision about a revision that has moved.
 */
async function evaluateLedgerAtArchive(
    root: string,
    taskId: string,
    /**
     * Whether the approval that cleared this change says it rested on the ledger.
     *
     * **This is the difference between a legitimate absence and a hole.** Measured before it existed: with the review
     * record marked `reviewRoute: 'ledger'` and the ledger directory removed, the gate's refusal named the fresh evidence
     * and the Judge and said nothing about the ledger at all — the entire basis of the approval could be deleted and the
     * gate still cleared the review half, because `evaluateReviewClearance` reads the record *about* the evidence rather
     * than the evidence.
     */
    restsOnLedger: boolean,
): Promise<DistillGateReport['ledger']> {
    const { ledgerVerdict } = await import('../store/verdict.js');
    const { ledgerDrift } = await import('../store/ledger.js');
    const verdict = await ledgerVerdict({ root, changeId: taskId });
    if (verdict.kind === 'absent') {
        return restsOnLedger
            ? {
                state: 'required-but-missing',
                detail: 'the review approval names the evidence ledger as its basis, and this change has no ledger',
                reasons: ['ledger_required_but_absent'],
            }
            : { state: 'absent', detail: verdict.detail, reasons: [] };
    }
    if (verdict.kind === 'unreadable') return { state: 'unreadable', detail: verdict.detail, reasons: [] };

    const drift = await ledgerDrift(root, taskId);
    if (drift && drift.unreadable.length > 0) {
        return {
            state: 'unreadable',
            detail: `the ledger names paths that cannot be read, so no comparison against the frozen subject is possible: ${drift.unreadable.join(', ')}`,
            reasons: [],
        };
    }
    const moved = drift ? [...drift.changed, ...drift.added, ...drift.removed] : [];
    if (moved.length > 0) {
        return {
            state: 'not-pass',
            detail: `the ledger describes content that has moved since it was frozen: ${moved.join(', ')}`
                + ' — the approval was about the frozen content, so re-freeze, re-verify the reopened claims, and re-decide',
            reasons: ['subject_drift'],
        };
    }
    if (verdict.decision.verdict !== 'pass') {
        return {
            state: 'not-pass',
            detail: `the ledger decides ${verdict.decision.verdict}, not a pass`
                + (verdict.decision.reasons.length > 0
                    ? `: ${verdict.decision.reasons.map((entry) => `${entry.code}${entry.claimId ? ` (${entry.claimId})` : ''}: ${entry.detail}`).join(' | ')}`
                    : '')
                // The remedy travels with the refusal. A gate that says only "this does not pass" sends the reader back
                // to the commands to find out which door reopens it, and the two doors are not interchangeable: making
                // the claim hold is the default, and waiving it is a decision someone signs.
                + ' — make each unsupported claim hold (`kata-cli ledger evidence add`, `ledger evidence verify`),'
                + ' or record the decision to live with it (`kata-cli ledger claim waive <id> --reason <why>`)',
            reasons: verdict.decision.reasons.map((entry) => entry.code),
        };
    }
    return { state: 'pass', detail: `the ledger decides a pass at the ${verdict.tier} tier`, reasons: [] };
}

/**
 * The gate itself: fails closed with one message, whatever the reason.
 *
 * The message names *which* condition failed rather than listing all three. It used to name all three always, so a
 * change that failed only on the ledger (or only on the judge) was told to go and look at three things — and the one
 * it had to fix was not identified. The refusal still fails closed; it just says what to fix.
 */
export async function assertDistillGates(root: string, taskId: string): Promise<void> {
    const report = await evaluateDistillGates(root, taskId);
    const failures: string[] = [];
    if (!report.freshEvidence) failures.push('no fresh passing test evidence is recorded for the current revision');
    if (!report.review.cleared) failures.push(`reviewer clearance is missing (${report.review.reason ?? 'unknown'})`);
    if (!report.judge.passed) failures.push(`the Judge has not passed this change (${report.judge.reason ?? 'unknown'})`);
    if (report.ledger.state === 'unreadable') failures.push(`the ledger cannot be read: ${report.ledger.detail}`);
    if (report.ledger.state === 'not-pass') failures.push(`the ledger does not pass: ${report.ledger.detail}`);
    if (report.ledger.state === 'required-but-missing') {
        // The refusal has to say *why* an absent ledger is a failure here and not elsewhere, because the two states look
        // identical from the outside and only the approval's own record tells them apart.
        failures.push(
            `the review approval rests on the evidence ledger, and that ledger is gone: ${report.ledger.detail}. `
            + 'An approval cannot outlive the evidence it names — re-record the ledger (`ledger freeze`, `ledger claim add`, '
            + '`ledger evidence add|verify`, `ledger decide`) so the decision about this content can be read again.',
        );
    }
    if (failures.length === 0) return;
    throw new Error(`Cannot enter distill: ${failures.join('; ')}`);
}
