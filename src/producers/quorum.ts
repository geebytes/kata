/**
 * Quorum — several reviewers, compared by evidence rather than by vote.
 *
 * Two rules with reasons. First, a quorum must be *diverse* to count: two reviewers drawn from one family share their
 * blind spots, so paying twice for them buys two correlated errors. Second — and this is the load-bearing one — a
 * reproducible finding is never voted away: a `refuted` verdict from any reviewer stays in the merged set, so a majority
 * cannot silence a counterexample. Disagreement is *reported*, and the human decides.
 */
import type { EvidenceVerdict } from '../kernel/types.js';

export type QuorumRecord = {
    id: string;
    /** How this reviewer differs from the others: model family, prompt strategy, tool profile. */
    diversity: string;
    verdicts: readonly EvidenceVerdict[];
};

export type QuorumOutcome = {
    reviewers: number;
    /** Evidence the reviewers disagree about. */
    disputedEvidenceIds: string[];
    /** The claims whose evidence is disputed. */
    disputedClaimIds: string[];
    /** True when the reviewers were not diverse enough for the count to mean independence. */
    undiversified: boolean;
    /** Every verdict, with refutations preserved regardless of how many reviewers disagreed. */
    merged: EvidenceVerdict[];
    /** Plain-language statement of the rule actually applied, so a reader can see it was applied. */
    rule: string;
};

export function aggregateQuorum(input: {
    records: readonly QuorumRecord[];
    evidenceToClaim: Record<string, string>;
    /** The number of reviewers the tier asked for. */
    requiredReviewers: number;
    /** Whether the tier demands diversity among them. */
    demandDiversity: boolean;
}): QuorumOutcome {
    const merged: EvidenceVerdict[] = [];
    const byEvidence = new Map<string, Set<EvidenceVerdict['verdict']>>();
    for (const record of input.records) {
        for (const verdict of record.verdicts) {
            merged.push(verdict);
            const seen = byEvidence.get(verdict.evidenceId) ?? new Set<EvidenceVerdict['verdict']>();
            seen.add(verdict.verdict);
            byEvidence.set(verdict.evidenceId, seen);
        }
    }

    const disputedEvidenceIds = [...byEvidence.entries()]
        .filter(([, verdicts]) => verdicts.size > 1)
        .map(([evidenceId]) => evidenceId)
        .sort();
    const disputedClaimIds = [
        ...new Set(disputedEvidenceIds.map((evidenceId) => input.evidenceToClaim[evidenceId]).filter((id): id is string => Boolean(id))),
    ].sort();

    const distinctDiversity = new Set(input.records.map((record) => record.diversity).filter((value) => value !== 'none'));
    const undiversified = input.demandDiversity && input.records.length >= 2 && distinctDiversity.size < 2;

    const parts: string[] = [
        `${input.records.length} of ${input.requiredReviewers} required reviewer(s) submitted`,
        disputedEvidenceIds.length === 0 ? 'no disagreement' : `${disputedEvidenceIds.length} disputed evidence item(s)`,
        undiversified ? 'reviewers were not diverse, so the count adds no independent signal' : 'reviewers were diverse',
        'a refuted verdict is preserved: a reproducible finding is not voted away',
    ];

    return {
        reviewers: input.records.length,
        disputedEvidenceIds,
        disputedClaimIds,
        undiversified,
        merged,
        rule: parts.join('; '),
    };
}
