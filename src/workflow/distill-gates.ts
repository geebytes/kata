import type { EvidenceEnvelope } from '../quality/evidence.js';
import { checkFreshness, computeDiffHash, readRecordedEvidence } from '../quality/evidence.js';
import { readValidatedOptional } from '../core/schema.js';
import { join } from 'node:path';
import { readTaskRevision, revisionStatus } from './revision.js';
import type { JudgeResult } from '../quality/judge.js';
import { judgePath, reviewPath } from '../core/layout.js';

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
            if ((await revisionStatus(root, revision)).status !== 'current') continue;
            return { evidence: envelope, revisionId: envelope.revisionId };
        }
        if (checkFreshness(envelope, currentDiffHash).fresh) return { evidence: envelope };
    }
    return null;
}

export interface ReviewClearance {
    cleared: boolean;
    revisionId?: string;
    reason?: 'not_approved' | 'no_review_evidence' | 'blocking_findings' | 'stale_review';
}

/** Reviewer clearance: an approved review, backed by evidence, without blocking findings, for the sealed revision. */
export async function evaluateReviewClearance(
    root: string,
    taskId: string,
    revisionId?: string,
): Promise<ReviewClearance> {
    const review = await readValidatedOptional<{
        findings?: Array<{ severity?: string }>;
        revisionId?: string;
        status?: string;
        reviewEvidence?: string;
    }>('review', reviewPath(root, taskId));
    if (!review) return { cleared: false, reason: 'not_approved' };
    if (review.status !== 'approved') return { cleared: false, reason: 'not_approved' };
    if (!review.reviewEvidence?.trim()) return { cleared: false, reason: 'no_review_evidence' };
    if (!Array.isArray(review.findings) || review.findings.some((finding) => finding.severity === 'blocking')) {
        return { cleared: false, reason: 'blocking_findings' };
    }
    if (revisionId && review.revisionId !== revisionId) return { cleared: false, reason: 'stale_review' };
    return { cleared: true, ...(revisionId ? { revisionId } : {}) };
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
        if (judge.revisionId !== input.freshEvidence.revisionId) return { passed: false, reason: 'stale_judgement' };
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
}

export async function evaluateDistillGates(root: string, taskId: string): Promise<DistillGateReport> {
    const currentDiffHash = await computeDiffHash(root);
    const freshEvidence = await freshPassingTestEvidence(root, taskId, currentDiffHash);
    const [review, judge] = await Promise.all([
        evaluateReviewClearance(root, taskId, freshEvidence?.revisionId),
        evaluateJudgePass({ root, taskId, currentDiffHash, freshEvidence }),
    ]);

    return { freshEvidence, review, judge };
}

/** The gate itself: fails closed with one message, whatever the reason. */
export async function assertDistillGates(root: string, taskId: string): Promise<void> {
    const report = await evaluateDistillGates(root, taskId);
    if (report.freshEvidence && report.review.cleared && report.judge.passed) return;
    throw new Error('Cannot enter distill until fresh evidence, reviewer clearance, and judge PASS are present');
}
