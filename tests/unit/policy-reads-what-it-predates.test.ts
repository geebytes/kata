import { describe, expect, it } from 'vitest';
import { defaultPolicy, loadPolicy } from '../../src/kernel/policy.js';

/**
 * **A stored policy is read the way it was written, and a required field that invalidates older documents is the defect,
 * not the fix.**
 *
 * Measured on this repository: `ledgerTierCeiling` was added as a required top-level section, and the three ledgers written
 * before it became `unreadable` — `ledger decide` refused with "the stored policy was refused … so nothing here decides",
 * on a store of record where the ledger is the only place the evidence lives. A reader that cannot read the record has
 * destroyed it rather than reported a gap.
 *
 * The rule is the one the evidence reader already follows (`passed ?? exitCode === 0`): a **missing** section takes the
 * value its absence implied and the fill is **reported**, while an **unknown** section still refuses — absence is history,
 * an extra key is a declaration with no consumer, and the two are different facts.
 */
describe('a stored policy that predates a section is read, and the fill is named', () => {
    const stored = (): Record<string, unknown> => {
        const policy = JSON.parse(JSON.stringify(defaultPolicy())) as Record<string, unknown>;
        return policy;
    };

    it('fills an absent section from the default and reports which one', () => {
        const value = stored();
        delete value.ledgerTierCeiling;
        const loaded = loadPolicy(value);
        expect(loaded.ok).toBe(true);
        if (!loaded.ok) return;
        expect(loaded.filled).toEqual(['ledgerTierCeiling']);
        // The value is the default's, not a guess: the ceiling a document without one implied is the one this build
        // declares as its own default.
        expect(loaded.policy.ledgerTierCeiling).toBe(defaultPolicy().ledgerTierCeiling);
    });

    it('fills nothing for a policy that carries every section, and says so', () => {
        const loaded = loadPolicy(stored());
        expect(loaded.ok).toBe(true);
        if (!loaded.ok) return;
        expect(loaded.filled).toEqual([]);
    });

    it('still refuses a section nothing reads, because that is a different fact from an absent one', () => {
        const loaded = loadPolicy({ ...stored(), somethingNobodyReads: 1 });
        expect(loaded.ok).toBe(false);
        if (loaded.ok) return;
        expect(loaded.error).toContain('unknown field');
    });

    it('still refuses a section whose value is wrong, even when others must be filled', () => {
        const value = stored();
        delete value.ledgerTierCeiling;
        value.tiers = { standard: {} };
        const loaded = loadPolicy(value);
        expect(loaded.ok, 'a malformed section is not history').toBe(false);
    });
});
