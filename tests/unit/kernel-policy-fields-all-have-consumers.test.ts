import { describe, expect, it } from 'vitest';
import { defaultPolicy, loadPolicy, meetsAssuranceFloor, policyKeyPaths, POLICY_CONSUMERS, tierPolicy } from '../../src/kernel/policy.js';
import { classifyRisk } from '../../src/kernel/risk.js';

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
        delete (tiers.strict as Record<string, unknown>).assuranceFloor;
        const loaded = loadPolicy({ ...base, tiers });
        expect(loaded.ok).toBe(false);
        if (!loaded.ok) expect(loaded.error).toContain('tiers.strict.assuranceFloor');
    });

    it('refuses an unknown version instead of guessing', () => {
        const loaded = loadPolicy({ ...defaultPolicy(), version: 2 });
        expect(loaded.ok).toBe(false);
        if (!loaded.ok) expect(loaded.error).toContain('version 1');
    });

    it('puts the assurance decision in the policy, not in the code', () => {
        const policy = defaultPolicy();
        // A floor, not a set: the tier says how weak an assurance it will accept, and anything stronger passes.
        expect(tierPolicy(policy, 'standard').assuranceFloor).toBe('none');
        // Strict requires that kata observed the evidence: on the ledger route the approval is held by the evidence,
        // and an evidence set nobody watched being produced is not enough for it.
        expect(tierPolicy(policy, 'strict').assuranceFloor).toBe('observed');
        // Security retains its stronger review, quorum and risk coverage contract. Its
        // assurance is observed because the host platform, not Kata, owns command isolation.
        expect(tierPolicy(policy, 'security').assuranceFloor).toBe('observed');
        expect(meetsAssuranceFloor(policy, 'standard', 'observed')).toBe(true);
        expect(meetsAssuranceFloor(policy, 'security', 'observed')).toBe(true);
        expect(meetsAssuranceFloor(policy, 'security', 'signed')).toBe(true);

        // The tier's risk contract is data too, and it is what makes the coverage check failable: a class the tier requires
        // and no claim covers is a hole rather than something derived from the claims themselves.
        expect(tierPolicy(policy, 'standard').requiredRiskClasses).toEqual(['consistency']);
        expect(tierPolicy(policy, 'strict').requiredRiskClasses).toContain('failure_mode');
        expect(tierPolicy(policy, 'security').requiredRiskClasses).toContain('privilege');

        // **The high floor has to exist or the security tier is unreachable by classification.** The tier is the maximum
        // floor over the touched paths, so a policy with no `high` rule makes the stricter evidence, the higher assurance
        // floor, the quorum and the privilege risk class all inert — a mechanism nobody can reach is a mechanism nobody
        // has. This asserts the reachability rather than the table, because the table would look complete either way.
        const reached = classifyRisk({ paths: ['src/kernel/decide.ts'], policy });
        expect(reached.floor).toBe('high');
        expect(reached.tier).toBe('security');
        const ordinary = classifyRisk({ paths: ['src/quality/change-record.ts'], policy });
        expect(ordinary.tier).toBe('strict');
    });
});
