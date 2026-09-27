/**
 * **The seed corpus for the new mechanism's own failure modes.**
 *
 * The audit's closing observation was that a corpus built only from the old system's defects cannot measure recall against
 * a mechanism that did not exist when those defects were found: the new design has failures of its own — a wrong
 * dependency edge, a reused verdict that should have reopened, a floor that is too low, adapters that diverge, reviewers
 * that are correlated. Each entry here is one such failure mode, written as a ledger and the decision it must produce.
 *
 * The corpus is also its own coverage check: `review-seed-corpus.test.ts` asserts every reason the kernel can produce
 * appears in at least one expectation, so adding a reason without a seed fails rather than quietly widening the vocabulary.
 */
import type { DecideInput } from '../../src/kernel/decide.js';
import type { ReasonCode } from '../../src/kernel/types.js';
import { makeClaim, makeEvidence, makePolicy, makeSubject, makeVerdict } from '../helpers/review.js';
import { subjectOf } from '../../src/kernel/subject.js';

export type ReviewScenario = {
    id: string;
    /** Which failure mode of the new mechanism this seed is aimed at. */
    mode: 'clean' | 'delta' | 'strength' | 'challenge' | 'budget' | 'discovery' | 'assurance' | 'quorum' | 'coverage' | 'record';
    why: string;
    build: () => DecideInput;
    expect: { verdict: 'pass' | 'fail' | 'insufficient'; reasons: ReasonCode[]; reusedEvidence?: string[] };
    /** What this seed pins instead of a decision, when the property is owned by another layer. */
    note?: string;
};

const fileSubject = makeSubject({ 'src/a.ts': 'holds', 'src/b.ts': 'stable' });

function base(overrides: Partial<DecideInput> = {}): DecideInput {
    return {
        subject: fileSubject,
        claims: [makeClaim({ severity: 'major' })],
        evidence: [makeEvidence({})],
        verdicts: [makeVerdict({ subjectRevision: fileSubject.revision })],
        challenges: [],
        policy: makePolicy(),
        tier: 'strict',
        declaredRiskClasses: ['consistency'],
        assurance: 'observed',
        usage: {},
        discovery: { independentChallenges: 1 },
        ...overrides,
    };
}

export const reviewScenarios: ReviewScenario[] = [
    {
        id: 'clean',
        mode: 'clean',
        why: 'The baseline: if this one stops passing, every other expectation in the corpus is measuring the fixture.',
        build: () => base(),
        expect: { verdict: 'pass', reasons: [] },
    },
    {
        id: 'delta-moved-dependency',
        mode: 'delta',
        why: 'A verdict from the previous revision whose dependency moved must not support the claim it is bound to.',
        build: () => {
            const previous = subjectOf({ 'src/a.ts': 'holds', 'src/b.ts': 'stable' });
            const next = subjectOf({ 'src/a.ts': 'changed', 'src/b.ts': 'stable' });
            return base({
                subject: next,
                previous: { subject: previous, claims: [makeClaim({ severity: 'major' })] },
                verdicts: [makeVerdict({ subjectRevision: previous.revision })],
            });
        },
        expect: { verdict: 'insufficient', reasons: ['evidence_stale_subject'] },
    },
    {
        id: 'delta-unchanged-dependency',
        mode: 'delta',
        why: 'The other half of the same rule: identical digests keep their verdict, which is what stops a repair from costing a full re-review.',
        build: () => {
            // Both subjects are built the same way on purpose: the rule compares digests, so a fixture that computes them
            // differently from the subject under review would measure the fixture rather than the rule.
            const previous = subjectOf({ 'src/a.ts': 'holds', 'src/b.ts': 'stable' });
            const current = subjectOf({ 'src/a.ts': 'holds', 'src/b.ts': 'stable' });
            return base({
                subject: current,
                previous: { subject: previous, claims: [makeClaim({ severity: 'major' })] },
                verdicts: [makeVerdict({ subjectRevision: previous.revision })],
            });
        },
        expect: { verdict: 'pass', reasons: [], reusedEvidence: ['E1'] },
    },
    {
        id: 'delta-underivable-dependency',
        mode: 'delta',
        why: 'A dependency nobody can resolve must reopen everything rather than reuse what it cannot justify.',
        build: () => {
            const previous = subjectOf({ 'src/a.ts': 'holds' });
            const next = subjectOf({ 'src/a.ts': 'changed' });
            return base({
                subject: next,
                claims: [makeClaim({ severity: 'major', dependsOn: ['path:src/gone.ts'] })],
                previous: { subject: previous, claims: [makeClaim({ severity: 'major' })] },
                verdicts: [makeVerdict({ subjectRevision: previous.revision })],
            });
        },
        expect: { verdict: 'insufficient', reasons: ['evidence_stale_subject'] },
    },
    {
        id: 'strength-blocking-concurrence',
        mode: 'strength',
        why: 'Concurrence is the one type that turns "two reviewers said so" into evidence, and it may not carry a blocking claim.',
        build: () => base({
            claims: [makeClaim({ severity: 'blocking' })],
            evidence: [makeEvidence({ id: 'E1', type: 'expert_concurrence', reviewers: ['a', 'b'], humanAck: 'acks/1' })],
            verdicts: [makeVerdict({ evidenceId: 'E1', evidenceType: 'expert_concurrence', subjectRevision: fileSubject.revision })],
        }),
        expect: { verdict: 'insufficient', reasons: ['evidence_below_strength'] },
    },
    {
        id: 'verdict-inconclusive',
        mode: 'strength',
        why: 'An undecided check supports nothing, and saying so is not the same as calling the claim refuted.',
        build: () => base({ verdicts: [makeVerdict({ verdict: 'inconclusive', subjectRevision: fileSubject.revision })] }),
        expect: { verdict: 'insufficient', reasons: ['evidence_inconclusive'] },
    },
    {
        id: 'evidence-missing-verdict',
        mode: 'strength',
        why: 'A claim naming evidence that was never verified is a gap, not a pass on the strength of the declaration.',
        build: () => base({ verdicts: [] }),
        expect: { verdict: 'insufficient', reasons: ['evidence_missing'] },
    },
    {
        id: 'claim-without-evidence',
        mode: 'strength',
        why: 'A claim that names no evidence at all is unsupported by construction.',
        build: () => base({ claims: [makeClaim({ severity: 'major', evidenceIds: [] })] }),
        expect: { verdict: 'insufficient', reasons: ['claim_unsupported'] },
    },
    {
        id: 'challenge-open',
        mode: 'challenge',
        why: 'An open counterexample blocks, and it blocks without anyone having to agree that it is right.',
        build: () => base({
            challenges: [{
                id: 'X1',
                claimId: 'C1',
                command: 'run-it',
                failsOn: fileSubject.revision,
                state: 'open',
                at: '2026-09-27T00:00:00.000Z',
            }],
        }),
        expect: { verdict: 'insufficient', reasons: ['challenge_open'] },
    },
    {
        id: 'budget-spent',
        mode: 'budget',
        why: 'Cost is a scheduling input: a spent budget returns insufficient and can never return pass.',
        build: () => base({ usage: { tokens: 10_000_000 }, c0Tokens: 100 }),
        expect: { verdict: 'insufficient', reasons: ['budget_exhausted'] },
    },
    {
        id: 'discovery-floor-missing',
        mode: 'discovery',
        why: 'A tier at or above medium with no independent challenge has had no discovery, whatever the automatic evidence says.',
        build: () => base({ tier: 'strict', discovery: { independentChallenges: 0 } }),
        expect: { verdict: 'insufficient', reasons: ['discovery_floor'] },
    },
    {
        id: 'assurance-below-tier',
        mode: 'assurance',
        why: 'Process assurance is its own axis, judged against the tier threat model, and it is not the same question as whether the evidence holds.',
        build: () => base({ tier: 'security', assurance: 'none' }),
        expect: { verdict: 'insufficient', reasons: ['assurance_below_tier'] },
    },
    {
        id: 'quorum-undiversified',
        mode: 'quorum',
        why: 'Two reviewers from one family share their blind spots, so the count is not independence.',
        build: () => base({
            tier: 'security',
            assurance: 'sandboxed',
            quorum: { disputedClaimIds: [], undiversified: true, reviewers: 2 },
        }),
        expect: { verdict: 'insufficient', reasons: ['quorum_undiversified'] },
    },
    {
        id: 'quorum-disputed',
        mode: 'quorum',
        why: 'A disagreement is reported rather than averaged away.',
        build: () => base({ quorum: { disputedClaimIds: ['C1'], undiversified: false, reviewers: 2 } }),
        expect: { verdict: 'insufficient', reasons: ['quorum_disputed'] },
    },
    {
        id: 'quorum-cannot-silence-a-refutation',
        mode: 'quorum',
        why: 'The load-bearing quorum rule: a reproducible finding is not voted away, so a refuted verdict decides even when the reviewers agree.',
        build: () => base({
            verdicts: [makeVerdict({ verdict: 'refuted', subjectRevision: fileSubject.revision })],
            quorum: { disputedClaimIds: [], undiversified: false, reviewers: 2 },
        }),
        expect: { verdict: 'fail', reasons: ['evidence_refuted'] },
    },
    {
        id: 'uncovered-risk-class',
        mode: 'coverage',
        why: 'Coverage is over the finite risk space, not over every path: a declared class no claim touches is a hole.',
        build: () => base({ declaredRiskClasses: ['consistency', 'rollback'] }),
        expect: { verdict: 'insufficient', reasons: ['uncovered_risk_class'] },
    },
    {
        id: 'a-check-that-cannot-fail',
        mode: 'strength',
        why: 'The failure mode the fifth evidence type was: a command-backed check with no mutation is refused by shape, so an `exit 0` cannot reach a decision through a value that has no question to answer.',
        build: () => base({ evidence: [makeEvidence({ id: 'E1', type: 'executable_falsifier', command: 'exit 0', mutation: { file: 'src/a.ts', find: 'holds', replace: 'broken' } })] }),
        expect: { verdict: 'pass', reasons: [] },
        note: 'The shape problem is asserted on its own below, because a corpus entry that passes cannot show a refusal.',
    },
    {
        id: 'a-check-with-no-mutation-is-not-evidence',
        mode: 'strength',
        why: 'The same check without a mutation is inadmissible — the hole this corpus is named after, pinned where it can fail.',
        // **Admissibility is a property of the item, not of the decision.** `decide` is pure over data that was already
        // admitted, so the refusal lives in `evidenceShapeProblems` (and at the CLI boundary that calls it); a corpus that
        // asserted it here would be testing a rule that does not exist in this layer.
        build: () => base({
            evidence: [{ id: 'E1', type: 'executable_falsifier', command: 'exit 0' } as never],
        }),
        expect: { verdict: 'pass', reasons: [] },
        note: 'shape-checked by evidenceShapeProblems, asserted in kernel-every-check-can-fail.test.ts',
    },
    {
        id: 'a-floor-that-classifies-nothing',
        mode: 'record',
        why: 'A risk floor no path reaches is a tier nobody can be routed to: the policy table would look complete and the security tier would be inert.',
        build: () => base(),
        expect: { verdict: 'pass', reasons: [] },
        note: 'Pinned as a policy property (classification reaches `high`), which is where reachability belongs.',
    },
    {
        id: 'a-counterexample-that-reproduces',
        mode: 'challenge',
        why: 'The branch the discovery rate has never exercised: every counterexample raised on the three changes that went through this route was measured and did NOT reproduce, so `refutationRate` has only ever been zero. This is the other side — a challenge that reproduces and therefore blocks.',
        build: () => base({
            challenges: [{
                id: 'X1',
                claimId: 'C1',
                command: 'npm test',
                failsOn: fileSubject.revision,
                state: 'open',
                at: '2026-09-27T00:00:00.000Z',
            }],
        }),
        expect: { verdict: 'insufficient', reasons: ['challenge_open'] },
    },
    {
        id: 'a-refuted-verdict-survives-the-counterexample',
        mode: 'challenge',
        why: 'A reproducing counterexample against a refuted claim must not be softened by the refutation being present: `fail` outranks `insufficient`, and the counterexample is what a reader acts on.',
        build: () => base({
            verdicts: [makeVerdict({ verdict: 'refuted', subjectRevision: fileSubject.revision })],
            challenges: [{
                id: 'X1',
                claimId: 'C1',
                command: 'npm test',
                failsOn: fileSubject.revision,
                state: 'open',
                at: '2026-09-27T00:00:00.000Z',
            }],
        }),
        expect: { verdict: 'fail', reasons: ['evidence_refuted', 'challenge_open'] },
    },
    {
        id: 'waived-without-reason',
        mode: 'record',
        why: 'A waiver is a decision, and a decision without a reason is what the gate has to refuse.',
        build: () => base({
            claims: [makeClaim({ severity: 'major', status: 'waived' })],
        }),
        expect: { verdict: 'insufficient', reasons: ['waived_without_reason'] },
    },
];
