import { describe, expect, it } from 'vitest';
import { decide, type DecideInput } from '../../src/kernel/decide.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { classifyRisk } from '../../src/kernel/risk.js';
import { makeClaim, makeEvidence, makePolicy, makeSubject, makeVerdict } from '../helpers/review.js';

/**
 * **A risk class is required because the change reaches it, not because the tier lists it.**
 *
 * Measured, on a consistency-only repair: `decide` answered `insufficient` with `uncovered_risk_class: no claim covers:
 * failure_mode` and an *empty* deficit list, because `strict.requiredRiskClasses` names three classes for every change
 * that touches `src/quality/**` or `src/workflow/**` — whichever classes the change actually reaches. The only ways to
 * satisfy that are to declare a claim about a failure mode the change does not have (a gate satisfied by prose) or to
 * leave the change unable to pass at all.
 *
 * The rule is therefore `required ∩ touched ⊆ claimed`: a class the change does not reach is not demanded, a class it
 * does reach is demanded and named, and the refusal says which paths produced the demand so an author can act on it.
 */
function baseline(overrides: Partial<DecideInput> = {}): DecideInput {
    const subject = makeSubject({ 'src/quality/review-ladder.ts': 'the ladder', 'src/a.ts': 'holds' });
    return {
        subject,
        claims: [makeClaim({ riskClass: 'consistency' })],
        evidence: [makeEvidence({})],
        verdicts: [makeVerdict({ subjectRevision: subject.revision })],
        challenges: [],
        policy: makePolicy(),
        tier: 'strict',
        declaredRiskClasses: ['consistency', 'boundary', 'failure_mode'],
        touchedRiskClasses: ['consistency'],
        assurance: 'observed',
        usage: {},
        discovery: { independentChallenges: 1, verifiedChallenges: 1 },
        ...overrides,
    };
}

describe('the required risk classes are the ones the change touches', () => {
    it('passes a consistency-only change without a failure-mode claim, because the change cannot fail that way', () => {
        expect(decide(baseline()).verdict).toBe('pass');
    });

    it('still demands a class the change does reach, and names it', () => {
        const result = decide(baseline({
            // The same policy and the same claims; only what the change touches moved.
            touchedRiskClasses: ['consistency', 'failure_mode'],
        }));
        expect(result.verdict).toBe('insufficient');
        const uncovered = result.reasons.filter((reason) => reason.code === 'uncovered_risk_class');
        expect(uncovered).toHaveLength(1);
        expect(uncovered[0]?.detail).toContain('failure_mode');
    });

    it('does not demand a class the tier lists when the change touches none of the required ones', () => {
        // `standard` requires `consistency`; a change that touches only a boundary must not be asked for consistency.
        const result = decide(baseline({
            tier: 'standard',
            declaredRiskClasses: ['consistency'],
            touchedRiskClasses: ['boundary'],
            claims: [makeClaim({ riskClass: 'boundary' })],
            policy: makePolicy(),
        }));
        expect(result.reasons.map((reason) => reason.code)).not.toContain('uncovered_risk_class');
    });

    it('reads the touched classes off the paths, through one derivation', () => {
        const policy = defaultPolicy();
        const quality = classifyRisk({ paths: ['src/quality/review-ladder.ts'], policy });
        const kernel = classifyRisk({ paths: ['src/kernel/decide.ts'], policy });
        expect(quality.riskClasses).toEqual(['consistency']);
        expect(kernel.riskClasses).toContain('privilege');
        // The same call answers the floor, so the two cannot be derived from different walks of the same table.
        expect(quality.floor).toBe('medium');
        expect(kernel.floor).toBe('high');
    });
});