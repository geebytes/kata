import { describe, expect, it } from 'vitest';
import { reconcileCorpora, reconcileRepositoryCorpora } from '../../src/store/corpus.js';
import { reviewScenarios } from '../fixtures/review-scenarios.js';

/**
 * **The question neither corpus could ask: are they asking the same things?**
 *
 * The old corpus (27 cases about the round-shaped verifier) and the new one (the mechanism's own seeds) were built at
 * different times by different routes and never compared, so a reader of the match count had no way to know whether the
 * new corpus covers what the old one covered. This is a coverage question, not a recall one, and the output says so.
 *
 * What the case pins is the reconciliation's *honesty* on the two things that usually go wrong: a label the map does not
 * know (which must be reported as its own class rather than dropped, or the current side is understated) and the empty
 * side of the comparison (a class only one corpus holds must be named, because that is the gap the whole exercise is for).
 */
describe('the two corpora are reconciled rather than assumed to agree', () => {
    it('names the classes both sides hold, with the counts, and reports no gap on either side today', async () => {
        const reconciliation = await reconcileRepositoryCorpora();
        expect(reconciliation.retiredCases).toBe(27);
        expect(reconciliation.currentCases).toBe(reviewScenarios.length);
        expect(reconciliation.shared.map((entry) => entry.kind).sort()).toEqual([
            'a-clean-revision',
            'a-defect-that-shipped',
            'a-guard-that-refused-honest-work',
        ]);
        // Everything the retired corpus asks, the current one asks too — and the counts are the evidence, not the claim.
        expect(reconciliation.onlyRetired).toEqual([]);
        expect(reconciliation.onlyCurrent).toEqual([]);
        expect(reconciliation.measures).toContain('not recall');
    });

    it('reports an unmapped label as its own class instead of dropping it', () => {
        const reconciliation = reconcileCorpora({
            retired: [{ kinds: ['planted-defect'] }],
            current: [{ mode: 'a-mode-nobody-mapped' }],
        });
        // Both sides are named on their own: the mapped class exists only on the retired side here, and the unmapped mode
        // only on the current one. Dropping either would understate a corpus.
        expect(reconciliation.shared).toEqual([]);
        expect(reconciliation.onlyRetired).toEqual([{ kind: 'a-defect-that-shipped', retired: 1 }]);
        expect(reconciliation.onlyCurrent).toEqual([{ kind: 'a-mode-nobody-mapped', current: 1 }]);
    });

    it('names a class only the retired corpus holds, which is the gap the exercise exists to surface', () => {
        // `malicious-fixture` maps into `a-defect-that-shipped`, and the current side here holds only a clean revision — so
        // the shared class is the clean one and the shipped-defect class is a **retired-only gap**, named as such rather
        // than folded into an empty list. That is the whole point of the comparison: a question only one side asks.
        const reconciliation = reconcileCorpora({
            retired: [{ kinds: ['malicious-fixture'] }, { kinds: ['clean-revision'] }],
            current: [{ mode: 'clean' }],
        });
        expect(reconciliation.shared).toEqual([{ kind: 'a-clean-revision', retired: 1, current: 1 }]);
        expect(reconciliation.onlyRetired).toEqual([{ kind: 'a-defect-that-shipped', retired: 1 }]);

        // And the same in the other direction: a class the map does not know and only the retired side holds.
        const gap = reconcileCorpora({
            retired: [{ kinds: ['a-class-the-map-does-not-know'] }],
            current: [{ mode: 'clean' }],
        });
        expect(gap.onlyRetired).toEqual([{ kind: 'a-class-the-map-does-not-know', retired: 1 }]);
    });
});
