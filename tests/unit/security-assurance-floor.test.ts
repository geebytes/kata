import { describe, expect, it } from 'vitest';
import { decide } from '../../src/kernel/decide.js';
import { defaultPolicy, meetsAssuranceFloor, tierPolicy } from '../../src/kernel/policy.js';
import { makeSubject } from '../helpers/review.js';

/**
 * A security review remains expensive because it asks for two independent readers,
 * always-on quorum, and privilege/provenance coverage.  This policy migration changes
 * only where command isolation is owned: the host platform owns it, so Kata requires
 * its own observed execution rather than claiming a local sandbox it cannot provide.
 */
function securityDecision(assurance: 'relayed' | 'observed') {
    return decide({
        subject: makeSubject({ 'src/kernel/decide.ts': 'gate' }),
        claims: [],
        evidence: [],
        verdicts: [],
        challenges: [],
        policy: defaultPolicy(),
        tier: 'security',
        declaredRiskClasses: [],
        touchedRiskClasses: [],
        assurance,
        usage: {},
        discovery: { independentChallenges: 0, verifiedChallenges: 0 },
    });
}

describe('security assurance is platform-owned', () => {
    it('accepts observed evidence but still refuses relayed evidence at the security floor', () => {
        const policy = defaultPolicy();

        expect(tierPolicy(policy, 'security').assuranceFloor).toBe('observed');
        expect(meetsAssuranceFloor(policy, 'security', 'observed')).toBe(true);
        expect(meetsAssuranceFloor(policy, 'security', 'relayed')).toBe(false);
        expect(securityDecision('observed').reasons.map((entry) => entry.code)).not.toContain('assurance_below_tier');
        expect(securityDecision('relayed').reasons.map((entry) => entry.code)).toContain('assurance_below_tier');
    });
});
