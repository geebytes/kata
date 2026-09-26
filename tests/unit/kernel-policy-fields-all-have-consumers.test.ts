import { describe, expect, it } from 'vitest';
import { defaultPolicy, loadPolicy, policyKeyPaths, POLICY_CONSUMERS, tierPolicy } from '../../src/kernel/policy.js';

/**
 * **Every declared field must have a consumer, and every consumer must name a real field.**
 *
 * This is the invariant for the defect class this repository keeps finding — a declaration that claims more than it does.
 * A policy key nothing reads is dead weight that looks like a rule; a consumer naming a key that does not exist is a rule
 * nobody can see. The two sets must be equal, and a policy that breaks either side is refused by name.
 */
describe('the policy is data with no dead fields', () => {
    it('declares exactly the fields its consumers read', () => {
        expect(policyKeyPaths(defaultPolicy()).sort()).toEqual(Object.keys(POLICY_CONSUMERS).sort());
    });

    it('accepts its own default, so the fixture above is not the only thing that validates', () => {
        const loaded = loadPolicy(defaultPolicy());
        expect(loaded.ok).toBe(true);
    });

    it('refuses an unknown field by name, rather than accepting it silently', () => {
        const policy = defaultPolicy() as unknown as Record<string, unknown>;
        const loaded = loadPolicy({ ...policy, riskFloors: policy.riskFloors, unknownKnob: 1 });
        expect(loaded.ok).toBe(false);
        if (!loaded.ok) expect(loaded.error).toContain('unknownKnob');
    });

    it('refuses a tier that is missing a field, naming the tier and the field', () => {
        const base = defaultPolicy();
        const tiers = { ...base.tiers, strict: { ...base.tiers.strict } } as Record<string, unknown>;
        delete (tiers.strict as Record<string, unknown>).assurance;
        const loaded = loadPolicy({ ...base, tiers });
        expect(loaded.ok).toBe(false);
        if (!loaded.ok) expect(loaded.error).toContain('tiers.strict.assurance');
    });

    it('refuses an unknown version instead of guessing', () => {
        const loaded = loadPolicy({ ...defaultPolicy(), version: 2 });
        expect(loaded.ok).toBe(false);
        if (!loaded.ok) expect(loaded.error).toContain('version 1');
    });

    it('puts the assurance decision in the policy, not in the code', () => {
        const policy = defaultPolicy();
        expect(tierPolicy(policy, 'standard').assurance).toEqual(['none', 'relayed']);
        expect(tierPolicy(policy, 'strict').assurance).toEqual(['relayed', 'observed']);
        expect(tierPolicy(policy, 'security').assurance).toContain('sandboxed');
    });
});
