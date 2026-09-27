import { describe, expect, it } from 'vitest';
import { aggregateQuorum, groupByProducer, UNATTRIBUTED_RUN } from '../../src/kernel/quorum.js';
import { makeVerdict } from '../helpers/review.js';

/**
 * **The two ways a quorum can be wrong, both of which were live.**
 *
 * The aggregation was handed *every* producer the ledger's whole verdict list, so it saw one verdict per evidence item,
 * `disputed` was unreachable, and `reviewers` counted producer *names* — `security.reviewers: 2` was a number no run could
 * violate. That was the first defect.
 *
 * The first repair introduced the second one: verdicts with no `producer` were grouped as `unattributed:<evidenceId>:
 * <index>`, so each of them became its own reviewer. A ledger recorded before the field existed would therefore report N
 * independent reviewers for one run's N readings — the same failure, reintroduced by the fallback written to tolerate old
 * data. These cases pin both directions.
 */
describe('a quorum is a count of independent readings, not of names or verdicts', () => {
    // `undefined` must *remove* the producer, not inherit the helper's default: a fixture that silently keeps one would
    // test attributed data while claiming to test unattributed, which is the shape of every fixture defect this line has
    // found. Destructured out rather than overridden with `undefined`, which leaves the key present.
    const verdictOf = (evidenceId: string, runId: string | undefined, verdict: 'supported' | 'refuted' = 'supported') => {
        const { producer: _ignored, ...base } = makeVerdict({ evidenceId, verdict });
        return runId === undefined ? base : { ...base, producer: { runId, actor: `actor-${runId}` } };
    };

    it('counts two runs of one adapter as two readings, and one run twice as one', () => {
        const twoRuns = groupByProducer([verdictOf('E1', 'run-a'), verdictOf('E1', 'run-b')]);
        expect(twoRuns.records).toHaveLength(2);
        expect(twoRuns.unattributed).toBe(0);

        // The same reading submitted twice under one run id is still one observation, which is what stops "replay it" from
        // being a quorum.
        const oneRunTwice = groupByProducer([verdictOf('E1', 'run-a'), verdictOf('E2', 'run-a')]);
        expect(oneRunTwice.records).toHaveLength(1);
        expect(oneRunTwice.records[0]?.verdicts).toHaveLength(2);
    });

    it('treats every verdict without a producer as ONE reading, not one each', () => {
        // The regression this pins: `unattributed:<evidenceId>:<index>` made six old verdicts report as six reviewers, so a
        // security-tier change asking for two would have been satisfied by a single run recorded before the field existed.
        const grouped = groupByProducer([verdictOf('E1', undefined), verdictOf('E2', undefined), verdictOf('E3', undefined)]);
        expect(grouped.records).toHaveLength(1);
        expect(grouped.records[0]?.id).toBe(UNATTRIBUTED_RUN);
        expect(grouped.unattributed).toBe(3);

        const outcome = aggregateQuorum({
            records: grouped.records,
            evidenceToClaim: {},
            requiredReviewers: 2,
            demandDiversity: true,
            unattributed: grouped.unattributed,
        });
        expect(outcome.reviewers).toBe(1);
        // And the reason a quorum fell short is stated: missing provenance is a different fact from one reviewer, and only
        // one of the two is fixed by re-running.
        expect(outcome.rule).toContain('named no producer and were counted as one reading');
        expect(outcome.undiversified).toBe(false);
    });

    it('reports disagreement only for the same evidence item, not across items', () => {
        // Two reviewers covering different items have not disagreed — comparing across items is how a difference in
        // coverage reads as a conflict.
        const differentItems = aggregateQuorum({
            records: [
                { id: 'run-a', diversity: 'model_family', verdicts: [verdictOf('E1', 'run-a')] },
                { id: 'run-b', diversity: 'tool_profile', verdicts: [verdictOf('E2', 'run-b')] },
            ],
            evidenceToClaim: { E1: 'C1', E2: 'C2' },
            requiredReviewers: 2,
            demandDiversity: true,
        });
        expect(differentItems.disputedEvidenceIds).toEqual([]);
        expect(differentItems.disputedClaimIds).toEqual([]);

        // The same item decided two ways is a disagreement, and it names the claim it is about.
        const sameItem = aggregateQuorum({
            records: [
                { id: 'run-a', diversity: 'model_family', verdicts: [verdictOf('E1', 'run-a')] },
                { id: 'run-b', diversity: 'tool_profile', verdicts: [verdictOf('E1', 'run-b', 'refuted')] },
            ],
            evidenceToClaim: { E1: 'C1' },
            requiredReviewers: 2,
            demandDiversity: true,
        });
        expect(sameItem.disputedEvidenceIds).toEqual(['E1']);
        expect(sameItem.disputedClaimIds).toEqual(['C1']);
        // A refutation is never voted away: both readings survive into the merged set whatever the majority says.
        expect(sameItem.merged.map((verdict) => verdict.verdict).sort()).toEqual(['refuted', 'supported']);
    });

    it('calls two reviewers from one actor undiversified, because the count is not independence', () => {
        const sameActor = groupByProducer([verdictOf('E1', 'run-a'), verdictOf('E2', 'run-b')]);
        // `verdictOf` derives the actor from the run id, so make the two runs share an actor explicitly.
        const shared = { ...sameActor, records: sameActor.records.map((record) => ({ ...record, diversity: 'same-actor' })) };
        const outcome = aggregateQuorum({ records: shared.records, evidenceToClaim: {}, requiredReviewers: 2, demandDiversity: true });
        expect(outcome.reviewers).toBe(2);
        expect(outcome.undiversified).toBe(true);
        expect(outcome.rule).toContain('not diverse');
    });
});
