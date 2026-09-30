import { describe, expect, it } from 'vitest';
import { readingsForRevision } from '../../src/kernel/evidence.js';
import { aggregateQuorum, groupByProducer, type QuorumRecord } from '../../src/kernel/quorum.js';
import type { EvidenceVerdict } from '../../src/kernel/types.js';

/**
 * **A quorum counts independent runs, and the store has to keep them for it to count anything.**
 *
 * The kernel's aggregation was rewritten once already for exactly this reason — its comment records that
 * `security.reviewers: 2` was unenforceable because a single producer reached `security`. That fix regrouped the verdicts
 * by run; the store still replaced on the evidence id, so regrouping had nothing to regroup. These cases pin the count on
 * the *reads*, and the store cases beside them pin that both reads survive.
 */
function reading(runId: string, actor: string, evidenceId: string, verdict: EvidenceVerdict['verdict']): EvidenceVerdict {
    return {
        evidenceId,
        evidenceType: 'executable_falsifier',
        verdict,
        observed: 'exit 0',
        at: '2026-09-29T00:00:00.000Z',
        verifier: 'producers/verifiers#executable',
        subjectRevision: 'rev:1',
        producer: { runId, actor },
    };
}

const evidenceToClaim: Record<string, string> = { E1: 'C1', E2: 'C1' };

/**
 * What `ledgerVerdict` feeds the quorum: the readings that speak for the revision being decided, grouped by their run.
 *
 * Measured by an independent review: handing it *every* reading let a reading the ledger itself judges `stale` count as
 * one of the two independent reviewers, so the tier passed on the strength of a reading the rest of the kernel refuses to
 * use — the same fact (which readings are about this revision) answered two ways in two places.
 */
function reviewersFrom(readings: EvidenceVerdict[], currentRevision: string | null = null): { reviewers: number; undiversified: boolean } {
    const { records, unattributed } = groupByProducer(readingsForRevision(readings, currentRevision));
    return aggregateQuorum({ records, unattributed, evidenceToClaim, requiredReviewers: 2, demandDiversity: true });
}

describe('the quorum counts runs rather than entries', () => {
    it('counts two runs that decided the same evidence as two reviewers', () => {
        const count = reviewersFrom([
            reading('run-1', 'reviewer-a', 'E1', 'supported'),
            reading('run-1', 'reviewer-a', 'E2', 'supported'),
            reading('run-2', 'reviewer-b', 'E1', 'supported'),
            reading('run-2', 'reviewer-b', 'E2', 'supported'),
        ]);
        expect(count.reviewers).toBe(2);
        // Different actors are the only independence signal a single-machine ledger holds.
        expect(count.undiversified).toBe(false);
    });

    it('counts one run recorded twice as one reviewer, because a replay is not a second reading', () => {
        const count = reviewersFrom([
            reading('run-1', 'reviewer-a', 'E1', 'supported'),
            reading('run-1', 'reviewer-a', 'E1', 'supported'),
            reading('run-1', 'reviewer-a', 'E2', 'supported'),
        ]);
        expect(count.reviewers).toBe(1);
    });

    it('reports undiversified when two runs share an actor, so the count does not stand in for independence', () => {
        const count = reviewersFrom([
            reading('run-1', 'the-author', 'E1', 'supported'),
            reading('run-2', 'the-author', 'E1', 'supported'),
        ]);
        expect(count.reviewers).toBe(2);
        expect(count.undiversified).toBe(true);
    });

    it('an item decided differently by two runs is disputed, and the claim it belongs to is named', () => {
        const { records, unattributed } = groupByProducer([
            reading('run-1', 'reviewer-a', 'E1', 'supported'),
            reading('run-2', 'reviewer-b', 'E1', 'refuted'),
        ]);
        const count = aggregateQuorum({ records, unattributed, evidenceToClaim, requiredReviewers: 2, demandDiversity: true });
        expect(count.disputedEvidenceIds).toEqual(['E1']);
        expect(count.disputedClaimIds).toEqual(['C1']);
    });

    it('does not count a reading about another revision as a reviewer of this one', () => {
        // **Measured by an independent review, on a real flow.** After a re-seal, one run had read the new revision and
        // another had only read the old one; the ledger called the old reading `stale` in its own reasons and still counted
        // it, so the two-reviewer requirement was satisfied by a reading nothing else would decide on.
        const readings = [
            reading('run-1', 'reviewer-a', 'E1', 'supported'),
            reading('run-1', 'reviewer-a', 'E2', 'supported'),
            { ...reading('run-2', 'reviewer-b', 'E1', 'supported'), subjectRevision: 'rev:previous' },
            { ...reading('run-2', 'reviewer-b', 'E2', 'supported'), subjectRevision: 'rev:previous' },
        ].map((entry) => ({ ...entry, subjectRevision: entry.subjectRevision === 'rev:previous' ? 'rev:previous' : 'rev:current' }));
        expect(reviewersFrom(readings, 'rev:current').reviewers).toBe(1);
        expect(reviewersFrom(readings, null).reviewers).toBe(2);
    });

    it('does not read a disagreement across revisions as a dispute about this revision', () => {
        // The other face of the same defect: one run refuted the old content and another supports the current content, so
        // the two readings disagree about different things. The projection takes the current reading; the quorum used to
        // report a dispute over the pair, which is the projection and the quorum answering the same question differently.
        const readings = [
            { ...reading('run-1', 'reviewer-a', 'E1', 'refuted'), subjectRevision: 'rev:previous' },
            { ...reading('run-2', 'reviewer-b', 'E1', 'supported'), subjectRevision: 'rev:current' },
        ];
        const { records, unattributed } = groupByProducer(readingsForRevision(readings, 'rev:current'));
        const count = aggregateQuorum({ records, unattributed, evidenceToClaim, requiredReviewers: 2, demandDiversity: true });
        expect(count.disputedEvidenceIds).toEqual([]);
    });

    it('groups a reading with no producer under one unattributed run, so an old ledger reads as one reading', () => {
        const bare: EvidenceVerdict = {
            evidenceId: 'E1',
            evidenceType: 'executable_falsifier',
            verdict: 'supported',
            observed: 'exit 0',
            at: '2026-09-29T00:00:00.000Z',
            verifier: 'producers/verifiers#executable',
            subjectRevision: 'rev:1',
        };
        const records: QuorumRecord[] = groupByProducer([bare, { ...bare, evidenceId: 'E2' }]).records;
        expect(records).toHaveLength(1);
    });
});
