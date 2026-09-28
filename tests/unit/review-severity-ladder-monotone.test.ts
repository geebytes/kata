import { describe, expect, it } from 'vitest';
import {
    isMergeBlocking,
    mergeBlockingSeverities,
    reviewTierFor,
} from '../../src/workflow/review-read.js';

/**
 * The mode's ladder is monotone, and `security` is not weaker than `strict`.
 *
 * This is its own file because the seal mints one evidence item per declared `testSelector`: an acceptance row that
 * shares a selector with another row gets credited with the same evidence, and the other row fails verify for a level it
 * never had. Two requirements with two rows need two selectors.
 *
 * The behaviour pinned here is the correction: every copy of the rule compared the mode against the literal `'strict'`,
 * so `security` — the tier whose kernel policy asks for two reviewers, always-on quorum and a sandboxed assurance floor —
 * blocked on *less* than the tier below it.
 */
describe('the severity ladder is monotone across modes', () => {
    it('names the severities each mode refuses approval for', () => {
        expect(mergeBlockingSeverities('std')).toEqual(['blocking']);
        expect(mergeBlockingSeverities('strict')).toEqual(['blocking', 'major']);
        // The correction this change exists for: security was weaker than strict in every copy of the rule.
        expect(mergeBlockingSeverities('security')).toEqual(['blocking', 'major']);
    });

    it('answers "does this severity block" from the same ladder', () => {
        expect(isMergeBlocking('strict', 'blocking')).toBe(true);
        expect(isMergeBlocking('strict', 'major')).toBe(true);
        expect(isMergeBlocking('strict', 'minor')).toBe(false);
        expect(isMergeBlocking('std', 'major')).toBe(false);
        expect(isMergeBlocking('security', 'major')).toBe(true);
        // A severity outside the vocabulary is not silently promoted to blocking: the ladder names what blocks.
        expect(isMergeBlocking('security', 'note')).toBe(false);
        expect(isMergeBlocking('security', undefined)).toBe(false);
    });

    it('is monotone: std is strictly weaker than strict, and strict never exceeds security', () => {
        const std = new Set(mergeBlockingSeverities('std'));
        const strict = new Set(mergeBlockingSeverities('strict'));
        const security = new Set(mergeBlockingSeverities('security'));
        for (const severity of std) expect(strict.has(severity)).toBe(true);
        for (const severity of strict) expect(security.has(severity)).toBe(true);
        expect([...strict].some((severity) => !std.has(severity))).toBe(true);
    });

    it('keeps the workflow vocabulary and the kernel tier vocabulary one mapping apart', () => {
        expect(reviewTierFor('std')).toBe('standard');
        expect(reviewTierFor('strict')).toBe('strict');
        expect(reviewTierFor('security')).toBe('security');
        // An absent profile is a legacy task, and legacy tasks were held to the std ladder; a mode nobody can name does
        // not silently become the strictest one, because that would newly refuse work no rule ever refused.
        expect(reviewTierFor(undefined)).toBe('standard');
    });

});
