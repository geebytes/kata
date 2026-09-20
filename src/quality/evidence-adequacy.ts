import { checkFreshness, type EvidenceEnvelope } from './evidence.js';
import { evidenceCoversAcceptance, evidenceMatchesRow, getMatrixRowForAc, isEntrypointEvidenceKind } from './acceptance-matrix.js';
import type { AcceptanceMatrix } from '../core/task.js';
import type { ReviewFinding } from './reviewer.js';
import type { JudgeAcceptanceResult, RepairScope } from './judge.js';

/**
 * The one answer to "is this acceptance criterion actually evidenced?".
 *
 * The Judge and the workflow's verify step ask the same question and used to answer it with two copies of the same
 * ladder that had already diverged at the edges. They now call this evaluator; what genuinely differs between them is
 * an input, not a second implementation:
 *
 * - `rejectCrossRevision` — the Judge refuses to judge evidence that spans more than one revision, because a verdict
 *   computed over mixed revisions would be attached to neither.
 * - `unresolvedObligations` — verify carries repair obligations from the review and the Judge, which a Judge verdict
 *   cannot know about yet.
 */

/**
 * A passing envelope, under the contract the collector stamps (L2-01).
 *
 * This module used `envelope.exitCode === 0` to decide whether a test's evidence counts, which is the same disagreement
 * the seal had with claims: a check that must exit 1 proved its sentence and was read as a failure here. The `??` keeps
 * envelopes written before `passed` existed readable rather than silently re-classified.
 */
function isPassingEvidence(envelope: EvidenceEnvelope): boolean {
    return envelope.passed ?? envelope.exitCode === 0;
}

export interface AcceptanceAdequacyInput {
    acceptance: Array<{ id?: string; statement?: string }>;
    evidence: EvidenceEnvelope[];
    findings: ReviewFinding[];
    currentDiffHash: string;
    currentScopeHashes?: Map<string, string>;
    matrix?: AcceptanceMatrix;
    reviewMode?: string;
    unresolvedObligations?: Array<{ acceptanceId?: string; id: string; message: string }>;
    rejectCrossRevision?: boolean;
}

export interface AcceptanceAdequacyResult {
    acceptance: JudgeAcceptanceResult[];
    evidenceIds: string[];
    revisionIds: string[];
    /** True when evidence from more than one revision was seen, whatever the caller decided to do about it. */
    crossRevision: boolean;
}

/** The repair scope that says the evidence itself is unusable regardless of the criterion. */
const crossRevisionScope: RepairScope = 'cross_revision_evidence';

export function evaluateAcceptanceAdequacy(input: AcceptanceAdequacyInput): AcceptanceAdequacyResult {
    const revisionIds = [...new Set(input.evidence
        .map((evidence) => evidence.revisionId)
        .filter((id): id is string => Boolean(id)))];
    const crossRevision = revisionIds.length > 1;

    if (crossRevision && input.rejectCrossRevision) {
        return {
            acceptance: input.acceptance.map((criterion) => ({
                id: criterion.id ?? '',
                result: 'FAIL',
                repairScope: crossRevisionScope,
            })),
            evidenceIds: [],
            revisionIds,
            crossRevision,
        };
    }

    const freshEvidence = input.evidence.filter((evidence) => checkFreshness(
        evidence,
        input.currentDiffHash,
        input.currentScopeHashes?.get(evidence.id),
    ).fresh);
    // Phase 3's outcome contract, read through the reader that tolerates envelopes written before it.
    const isPassingTest = (evidence: EvidenceEnvelope): boolean => evidence.kind === 'test' && isPassingEvidence(evidence);
    const freshPassingTestEvidence = freshEvidence.filter(isPassingTest);
    const failingTestEvidence = freshEvidence.find((evidence) => evidence.kind === 'test' && !isPassingEvidence(evidence));
    const blockingFindings = input.findings.filter((finding) => finding.severity === 'blocking'
        || (input.reviewMode === 'strict' && finding.severity === 'major'));
    const obligations = input.unresolvedObligations ?? [];

    const acceptance = input.acceptance.map((criterion): JudgeAcceptanceResult => {
        const acceptanceId = criterion.id ?? '';
        const blockingFinding = blockingFindings.find((finding) => !finding.acceptanceId || finding.acceptanceId === acceptanceId);
        const obligation = obligations.find((item) => item.acceptanceId === acceptanceId || !item.acceptanceId);

        if (failingTestEvidence) return { id: acceptanceId, result: 'FAIL', repairScope: 'failing_evidence' };
        if (obligation) return { id: acceptanceId, result: 'FAIL', repairScope: 'unresolved_repair_obligation' };
        if (freshPassingTestEvidence.length === 0 && input.evidence.some((evidence) => evidence.kind === 'test')) {
            return { id: acceptanceId, result: 'FAIL', repairScope: 'stale_evidence' };
        }
        if (freshPassingTestEvidence.length === 0) return { id: acceptanceId, result: 'FAIL', repairScope: 'missing_test_evidence' };
        // L2-02: the row's own evidence, for **every** verification level. The old rule asked for row-specific
        // evidence only when the row was an entrypoint, so an unrelated passing test could satisfy any other
        // criterion — and because the gate could not tell which test proved which criterion, the only way to be sure
        // was to re-run everything. A missing or undecidable row stays fail-closed.
        const row = input.matrix ? getMatrixRowForAc(input.matrix, acceptanceId) : undefined;
        if (row) {
            // **Any** passing evidence kind, not only `test`: a row may require integration or entrypoint evidence, and
            // filtering to tests here would make those levels unsatisfiable — the same mis-scoping in the other
            // direction. The comment on the repair scope below names what the row asked for.
            const rowEvidence = freshEvidence.filter((item) => isPassingEvidence(item) && evidenceCoversAcceptance(row, acceptanceId, item));
            if (rowEvidence.length === 0) return { id: acceptanceId, result: 'FAIL', repairScope: 'insufficient_evidence_level' };
            if (blockingFinding) return { id: acceptanceId, result: 'FAIL', repairScope: 'blocking_review_finding' };
            return { id: acceptanceId, result: 'PASS', evidenceIds: rowEvidence.map((item) => item.id) };
        }
        if (blockingFinding) return { id: acceptanceId, result: 'FAIL', repairScope: 'blocking_review_finding' };
        // No row is a declaration gap, not a pass: the criterion cannot be evidenced structurally.
        return input.matrix
            ? { id: acceptanceId, result: 'FAIL', repairScope: 'no_acceptance_matrix_row' }
            : { id: acceptanceId, result: 'PASS', evidenceIds: freshPassingTestEvidence.map((item) => item.id) };
    });

    return {
        acceptance,
        evidenceIds: freshPassingTestEvidence.map((item) => item.id),
        revisionIds,
        crossRevision,
    };
}
