import { describe, expect, it } from 'vitest';
import { decide } from '../../src/kernel/decide.js';
import { REASON_MESSAGES, type ReasonCode } from '../../src/kernel/types.js';
import { reviewScenarios } from '../fixtures/review-scenarios.js';

/**
 * **The corpus for the new mechanism's own failure modes, and its own coverage check.**
 *
 * A corpus of the old system's defects cannot measure a mechanism that did not exist when those defects were found — the
 * new design has failures of its own: a wrong dependency edge, a verdict reused past the content it described, a floor set
 * too low, adapters that diverge, reviewers that are correlated. Each seed is one of those, and the last case asserts the
 * corpus covers every reason the kernel can produce, so a vocabulary that grows without a seed fails here rather than
 * becoming something nobody wrote down.
 */
describe('the seed corpus for the new mechanism', () => {
    for (const scenario of reviewScenarios) {
        it(`${scenario.id}: ${scenario.why}`, () => {
            const decision = decide(scenario.build());
            expect(decision.verdict, scenario.id).toBe(scenario.expect.verdict);
            const codes = decision.reasons.map((reason) => reason.code);
            for (const expected of scenario.expect.reasons) {
                expect(codes, `${scenario.id} expected ${expected}`).toContain(expected);
            }
            if (scenario.expect.verdict === 'pass') {
                expect(codes, `${scenario.id} passed with reasons`).toEqual([]);
            }
            if (scenario.expect.reusedEvidence) {
                expect(decision.reusedEvidence, scenario.id).toEqual(scenario.expect.reusedEvidence);
            }
        });
    }

    it('covers every reason the kernel can produce, so the vocabulary cannot grow silently', () => {
        const covered = new Set(reviewScenarios.flatMap((scenario) => scenario.expect.reasons));
        const missing = (Object.keys(REASON_MESSAGES) as ReasonCode[]).filter((code) => !covered.has(code));
        expect(missing, 'a reason with no seed is a failure mode nobody wrote down').toEqual([]);
    });

    it('names a distinct failure mode for every seed', () => {
        const ids = reviewScenarios.map((scenario) => scenario.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(new Set(reviewScenarios.map((scenario) => scenario.mode)).size).toBeGreaterThanOrEqual(8);
    });
});
