import { describe, expect, it } from 'vitest';
import { requiredAdversarialNodes } from '../../src/quality/adversarial.js';

/**
 * One certification owner.
 *
 * Verify's job is deterministic (evidence current, complete, attributable); Review is the independent look. Strict and
 * security used to buy a *second* unrestricted discovery pass back at Verify, which spends the same cold-start cost to
 * re-derive the same class of defect over the same candidate — measured at 128 tool calls / 2,627 s for one such round.
 * Stronger profiles now strengthen the single Review request (receipt, budget, benchmark policy) instead of adding a
 * second one. What must not change: Review's pass stays mandatory, fresh-context and fail-closed in every profile.
 */
describe('the assurance boundary', () => {
    it('assigns exactly one formal certification, in every profile', () => {
        for (const reviewMode of ['std', 'strict', 'security', undefined]) {
            expect(requiredAdversarialNodes({ ...(reviewMode ? { reviewMode } : {}) })).toEqual(['review']);
        }
    });

    it('never drops Review, whatever the mode', () => {
        for (const reviewMode of ['std', 'strict', 'security', undefined]) {
            expect(requiredAdversarialNodes({ ...(reviewMode ? { reviewMode } : {}) })).toContain('review');
        }
    });
});
