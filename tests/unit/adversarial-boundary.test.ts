import { describe, expect, it } from 'vitest';
import { requiredAdversarialNodes } from '../../src/quality/adversarial.js';

/**
 * L2-03: the standard path pays for one independent look, and the escalation buys the second back.
 *
 * Both nodes used to run identical passes over the same sealed evidence and the same reading set. What must not change
 * is that Review's pass stays mandatory, fresh-context and fail-closed.
 */
describe('the assurance boundary', () => {
    it('requires Review and not Verify on the standard path', () => {
        expect(requiredAdversarialNodes({})).toEqual(['review']);
        expect(requiredAdversarialNodes({ reviewMode: 'std' })).toEqual(['review']);
    });

    it('buys Verify back in the escalated modes', () => {
        expect(requiredAdversarialNodes({ reviewMode: 'strict' })).toEqual(['review', 'verify']);
        expect(requiredAdversarialNodes({ reviewMode: 'security' })).toEqual(['review', 'verify']);
    });

    it('never drops Review, whatever the mode', () => {
        for (const reviewMode of ['std', 'strict', 'security', undefined]) {
            expect(requiredAdversarialNodes({ ...(reviewMode ? { reviewMode } : {}) })).toContain('review');
        }
    });
});
