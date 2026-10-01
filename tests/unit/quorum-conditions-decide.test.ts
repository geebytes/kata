import { describe, expect, it } from 'vitest';
import { quorumOnHolds, unknownQuorumCondition, QUORUM_CONDITIONS } from '../../src/kernel/quorum.js';
import { defaultPolicy, loadPolicy } from '../../src/kernel/policy.js';

/**
 * **`tiers.<tier>.quorumOn` has to decide something.**
 *
 * Measured by an independent review: the field carried a consumer entry (`producers/quorum`) and was read by no executing
 * branch — `demandDiversity` was decided entirely by `diversity.requiredOn`, so `security.quorumOn: ['always']` looked
 * like enforcement and enforced nothing of its own. A declared field with a consumer record and no consumer is the shape
 * this repository removes most often, so the fix is a real one: the conditions are evaluated against the facts a decision
 * already has, and an unrecognised condition is refused rather than silently reading as "not demanded".
 */
describe('quorumOn is evaluated rather than declared', () => {
    const none = {
        disputedClaims: 0,
        undiversified: false,
        refutedEvidence: false,
        belowStrengthEvidence: false,
        reachedNewRiskClass: false,
        unclassifiedTier: false,
        highRisk: false,
    };

    it('demands the quorum unconditionally for `always`, and only on its condition otherwise', () => {
        expect(quorumOnHolds(['always'], none)).toBe(true);
        expect(quorumOnHolds(['disagreement'], none)).toBe(false);
        expect(quorumOnHolds(['disagreement'], { ...none, disputedClaims: 1 })).toBe(true);
        expect(quorumOnHolds(['weak_evidence'], { ...none, belowStrengthEvidence: true })).toBe(true);
        expect(quorumOnHolds(['high_risk'], { ...none, highRisk: true })).toBe(true);
        expect(quorumOnHolds(['new_class'], { ...none, reachedNewRiskClass: true })).toBe(true);
        expect(quorumOnHolds(['uncertainty'], { ...none, unclassifiedTier: true })).toBe(true);
        expect(quorumOnHolds(['undiversified'], { ...none, undiversified: true })).toBe(true);
        expect(quorumOnHolds(['refutation'], { ...none, refutedEvidence: true })).toBe(true);
        // An unsatisfied list demands nothing — the direction that keeps a declaration from being a permanent gate.
        expect(quorumOnHolds(['disagreement', 'weak_evidence'], none)).toBe(false);
    });

    it('refuses a condition nobody can evaluate, instead of reading it as not demanded', () => {
        expect(unknownQuorumCondition(['always'])).toBeNull();
        expect(unknownQuorumCondition(['always', 'vibes'])).toBe('vibes');

        const policy = defaultPolicy();
        const loaded = loadPolicy({
            ...policy,
            tiers: { ...policy.tiers, strict: { ...policy.tiers.strict, quorumOn: ['always', 'vibes'] } },
        });
        expect(loaded.ok).toBe(false);
        if (!loaded.ok) expect(loaded.error).toContain('vibes');

        // Every condition the shipped policy names is one this module can evaluate, so the two cannot drift apart.
        for (const tier of Object.values(policy.tiers)) {
            expect(unknownQuorumCondition(tier.quorumOn)).toBeNull();
        }
        expect(QUORUM_CONDITIONS.length).toBeGreaterThan(0);
    });
});
