import { describe, expect, it } from 'vitest';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { classifyRisk } from '../../src/kernel/risk.js';

/**
 * Retiring Kata's local sandbox claim must not make gate code an ordinary change.
 * This test keeps the security requirements together so deleting one requirement
 * cannot be mistaken for merely changing the assurance boundary.
 */
describe('security retains its high-risk review contract', () => {
    it('keeps high paths, two readers, always quorum and privilege/provenance coverage', () => {
        const policy = defaultPolicy();
        const classified = classifyRisk({ paths: ['src/kernel/decide.ts'], policy });
        const security = policy.tiers.security;

        expect(classified).toMatchObject({ floor: 'high', tier: 'security' });
        expect(security.reviewers).toBe(2);
        expect(security.quorumOn).toEqual(['always']);
        expect(security.requiredRiskClasses).toEqual(expect.arrayContaining(['privilege', 'provenance']));
    });
});
