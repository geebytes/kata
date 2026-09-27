import { describe, expect, it } from 'vitest';
import { classifyRisk, resolveTier } from '../../src/kernel/risk.js';
import { defaultPolicy } from '../../src/kernel/policy.js';

/**
 * **One derivation for the tier, so the plan cannot be weaker than its own gate.**
 *
 * Measured on a real change: `ledger plan` reported tier `standard` while `ledger decide` reported `strict`. Both were
 * reading the same policy; only the decision applied `ledgerTierCeiling`. The ceiling exists because a floor is only as
 * good as its patterns — a change to what evidence is accepted sits under a pattern no risk rule names — so the command
 * that skipped it was computing the plan's required evidence and risk classes for a weaker tier than the one being
 * enforced. A plan weaker than its gate is worse than no plan, because it reads like a specification.
 */
const policy = defaultPolicy();

describe('the tier is derived once', () => {
    it('applies the policy ceiling, so a low-risk path set is still reviewed at the ceiling', () => {
        const classification = classifyRisk({ paths: ['src/wiki/llmwiki.ts'], policy });
        expect(classification.tier, 'the classification alone says standard').toBe('standard');
        expect(resolveTier({ classification, policy }), 'the tier the decision uses is the ceiling').toBe(policy.ledgerTierCeiling);
        expect(policy.ledgerTierCeiling).toBe('strict');
    });

    it('keeps a higher classification, because the ceiling is a floor on the tier and not a cap', () => {
        // `src/kernel/decide.ts` carries a `high` risk floor, so a change touching it classifies above the ceiling.
        const classification = classifyRisk({ paths: ['src/kernel/decide.ts'], policy });
        expect(resolveTier({ classification, policy })).toBe('security');
    });

    it('lets an explicit override win in both directions', () => {
        const classification = classifyRisk({ paths: ['src/wiki/llmwiki.ts'], policy });
        expect(resolveTier({ classification, policy, override: 'standard' })).toBe('standard');
        expect(resolveTier({ classification, policy, override: 'security' })).toBe('security');
    });
});
