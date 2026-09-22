import { hashContent } from '../core/hash.js';

/**
 * Immutable facts available when a change is frozen for independent certification.
 *
 * This is deliberately a value object: it contains the facts the planner compares, not a reviewer conclusion.
 * A fresh `revisionId` is absent because IDs are allocation details; content and declared semantics decide whether a
 * previous certification still answers the new candidate.
 */
export interface CandidateFreeze {
    hash: string;
    contentDigests: Record<string, string>;
    acceptanceHash: string;
    instrumentHash: string;
    reviewPolicyHash: string;
    executorBoundaryHash: string;
    /**
     * The ReviewIR this certification answered, carried for audit and receipt binding.
     *
     * Deliberately **excluded from `hash`**: the IR carries `evidenceIds`, so hashing it whole made the platform's own
     * check configuration part of the certification identity. Measured on a real task — sealing identical bytes under a
     * different check set moved this field alone and expired a completed certification, which is the cost §7.4 exists to
     * remove. What a certification is bound to is the reviewed content and the semantic contract, not how the platform
     * happens to check it.
     */
    reviewIrHash: string;
    reviewedPaths: string[];
    criterionPaths: Record<string, string[]>;
    evidenceByCriterion: Record<string, string>;
}

export type CandidateFreezeInput = Omit<CandidateFreeze, 'hash'>;

export interface UnresolvedFindingTarget {
    id: string;
    targetPaths: string[];
}

export type ReCertificationDecision =
    | {
        kind: 'no_review_needed';
        reason: 'outside_reviewed_surface';
        changedPaths: string[];
        reusedFreezeHash: string;
    }
    | {
        kind: 'targeted_review';
        reason: 'criteria_impacted';
        changedPaths: string[];
        criterionIds: string[];
        previousFreezeHash: string;
    }
    | {
        kind: 'full_review';
        reason: 'semantic_contract_changed' | 'review_scope_changed' | 'unmapped_reviewed_path' | 'unresolved_finding_implicated';
        changedPaths: string[];
        previousFreezeHash: string;
    };

/** Produces a content-addressed CandidateFreeze with stable ordering for persistence and comparison. */
export function freezeCandidate(input: CandidateFreezeInput): CandidateFreeze {
    const candidate = canonicalCandidate(input);
    const { reviewIrHash: _auditedOnly, ...identity } = candidate;
    return { ...candidate, hash: hashContent(JSON.stringify(identity)) };
}

/**
 * Decides whether a completed independent certification may be reused after a repair.
 *
 * The function is intentionally pure and fail-closed. It never decides that a pass is valid because a revision ID
 * happens to match; it returns reuse only after proving every changed path is outside the reviewed surface and every
 * contract identity is unchanged.
 */
export function planReCertification(
    previous: CandidateFreeze,
    current: CandidateFreeze,
    unresolvedFindings: readonly UnresolvedFindingTarget[],
): ReCertificationDecision {
    const changedPaths = diffPaths(previous.contentDigests, current.contentDigests);
    const base = { changedPaths, previousFreezeHash: previous.hash };

    if (
        previous.acceptanceHash !== current.acceptanceHash
        || previous.instrumentHash !== current.instrumentHash
        || previous.reviewPolicyHash !== current.reviewPolicyHash
        || previous.executorBoundaryHash !== current.executorBoundaryHash
    ) {
        return { kind: 'full_review', reason: 'semantic_contract_changed', ...base };
    }

    if (!samePaths(previous.reviewedPaths, current.reviewedPaths) || !sameCriterionPaths(previous.criterionPaths, current.criterionPaths)) {
        return { kind: 'full_review', reason: 'review_scope_changed', ...base };
    }

    const reviewed = new Set(current.reviewedPaths);
    if (unresolvedFindings.some((finding) => finding.targetPaths.length === 0 || finding.targetPaths.some((path) => reviewed.has(path)))) {
        return { kind: 'full_review', reason: 'unresolved_finding_implicated', ...base };
    }

    const reviewedChangedPaths = changedPaths.filter((path) => reviewed.has(path));
    const unmappedPath = reviewedChangedPaths.find((path) => criteriaForPath(current.criterionPaths, path).length === 0);
    if (unmappedPath) return { kind: 'full_review', reason: 'unmapped_reviewed_path', ...base };

    const impactedCriteria = new Set(reviewedChangedPaths.flatMap((path) => criteriaForPath(current.criterionPaths, path)));
    for (const criterionId of changedEvidenceCriteria(previous.evidenceByCriterion, current.evidenceByCriterion)) impactedCriteria.add(criterionId);

    if (impactedCriteria.size === 0) {
        return {
            kind: 'no_review_needed',
            reason: 'outside_reviewed_surface',
            changedPaths,
            reusedFreezeHash: previous.hash,
        };
    }

    const unknownEvidenceCriterion = [...impactedCriteria].find((criterionId) => !(criterionId in current.criterionPaths));
    if (unknownEvidenceCriterion) return { kind: 'full_review', reason: 'semantic_contract_changed', ...base };

    return {
        kind: 'targeted_review',
        reason: 'criteria_impacted',
        changedPaths,
        criterionIds: [...impactedCriteria].sort(),
        previousFreezeHash: previous.hash,
    };
}

/**
 * The criteria a narrowed round carries, and the ones it explicitly does not re-check.
 *
 * A `targeted_review` decision that only *reports* itself leaves the round full-sized: the reviewer still receives every
 * criterion and re-derives the untouched ones, which is the cost §7.3 exists to remove. Narrowing must not turn into
 * deletion, though — a round that silently drops a criterion cannot be distinguished from one that forgot it. So the
 * impact set is carried as the round's remit and everything else is named as carried over from the prior certification.
 */
export interface TargetedReviewPlan {
    criterionIds: string[];
    carriedOverCriterionIds: string[];
}

export function targetedReviewPlan(
    decision: ReCertificationDecision,
    declaredCriterionIds: readonly string[],
): TargetedReviewPlan {
    const declared = [...new Set(declaredCriterionIds)].sort();
    if (decision.kind !== 'targeted_review') {
        return { criterionIds: declared, carriedOverCriterionIds: [] };
    }
    const impacted = new Set(decision.criterionIds);
    return {
        criterionIds: declared.filter((id) => impacted.has(id)),
        carriedOverCriterionIds: declared.filter((id) => !impacted.has(id)),
    };
}

function canonicalCandidate(input: CandidateFreezeInput): CandidateFreezeInput {
    // `freezeCandidate({ ...previousFreeze })` is a convenient caller shape. Ignore a runtime `hash` carried by that
    // spread: the identity must describe candidate facts, never the identity of the candidate it was copied from.
    return {
        contentDigests: sortedRecord(input.contentDigests),
        acceptanceHash: input.acceptanceHash,
        instrumentHash: input.instrumentHash,
        reviewPolicyHash: input.reviewPolicyHash,
        executorBoundaryHash: input.executorBoundaryHash,
        reviewIrHash: input.reviewIrHash,
        reviewedPaths: uniqueSorted(input.reviewedPaths),
        criterionPaths: Object.fromEntries(Object.entries(input.criterionPaths).sort(([a], [b]) => a.localeCompare(b)).map(([id, paths]) => [id, uniqueSorted(paths)])),
        evidenceByCriterion: sortedRecord(input.evidenceByCriterion),
    };
}

function sortedRecord(record: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function uniqueSorted(paths: readonly string[]): string[] {
    return [...new Set(paths)].sort();
}

function diffPaths(previous: Record<string, string>, current: Record<string, string>): string[] {
    return [...new Set([...Object.keys(previous), ...Object.keys(current)])]
        .filter((path) => previous[path] !== current[path])
        .sort();
}

function criteriaForPath(criterionPaths: Record<string, string[]>, path: string): string[] {
    return Object.entries(criterionPaths)
        .filter(([, paths]) => paths.includes(path))
        .map(([criterionId]) => criterionId)
        .sort();
}

function changedEvidenceCriteria(previous: Record<string, string>, current: Record<string, string>): string[] {
    return [...new Set([...Object.keys(previous), ...Object.keys(current)])]
        .filter((criterionId) => previous[criterionId] !== current[criterionId])
        .sort();
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
    return JSON.stringify(uniqueSorted(left)) === JSON.stringify(uniqueSorted(right));
}

function sameCriterionPaths(left: Record<string, string[]>, right: Record<string, string[]>): boolean {
    return JSON.stringify(canonicalCriterionPaths(left)) === JSON.stringify(canonicalCriterionPaths(right));
}

function canonicalCriterionPaths(value: Record<string, string[]>): Record<string, string[]> {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([id, paths]) => [id, uniqueSorted(paths)]));
}
