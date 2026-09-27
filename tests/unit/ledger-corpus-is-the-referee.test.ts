import { describe, expect, it } from 'vitest';
import { scoreSeedCorpus, type SeedScorer } from '../../src/store/corpus.js';
import { reviewScenarios } from '../fixtures/review-scenarios.js';
import { REASON_MESSAGES, type ReasonCode } from '../../src/kernel/types.js';

/**
 * **The referee exists, and it can disagree.**
 *
 * The gap this closes: the mechanism's own seed corpus was read by one test file while `scoreCorpus` scored a different
 * corpus from a hand-written manifest, so "what does this mechanism decide on the corpus of its own failure modes" was
 * unanswerable — which is why the plan's acceptance criteria said *not measurable* instead of *passing*. The scorer is
 * now an entry point (`ledger corpus`), and these cases pin the three properties that make it a referee rather than a
 * scoreboard: it reports a disagreement instead of averaging it away, it checks the reasons and not only the verdict, and
 * it says what it does **not** measure.
 */
describe('the seed corpus scored by the mechanism that owns it', () => {
    const corpus = { scenarios: reviewScenarios } as SeedScorer;

    it('scores the repository corpus with no disagreement, and reports the shape it saw', () => {
        const score = scoreSeedCorpus(corpus);
        expect(score.mismatched, 'a mismatch is either a defect or a wrong expectation, and this lists both sides').toEqual([]);
        expect(score.matched).toBe(score.cases);
        expect(score.cases).toBeGreaterThanOrEqual(22);
        // The verdict distribution is reported, so a corpus that drifts toward one outcome is visible as a trend.
        expect(Object.keys(score.byVerdict).sort()).toEqual(['fail', 'insufficient', 'pass']);
        expect(score.byVerdict.fail).toBeGreaterThan(0);
    });

    it('refuses a decision that reaches the right verdict for a reason nobody wrote down', () => {
        // The weaker form of a mismatch: verdicts agree, the required reasons do not. A scorer that compared only the
        // verdict would call this a pass, and the codepath would be green for a reason the seed never claimed.
        const weakened = scoreSeedCorpus({
            scenarios: [{
                id: 'expects-two-reasons',
                mode: 'challenge',
                why: 'fixture: the verdict agrees and the reasons do not',
                build: corpus.scenarios.find((scenario) => scenario.expect.reasons.length > 1)!.build,
                expect: { verdict: corpus.scenarios.find((scenario) => scenario.expect.reasons.length > 1)!.expect.verdict, reasons: ['challenge_open', 'quorum_disputed'] },
            }],
        });
        expect(weakened.mismatched.map((entry) => entry.id)).toEqual(['expects-two-reasons']);
        expect(weakened.mismatched[0]?.missing).toEqual(['quorum_disputed']);
        expect(weakened.matched).toBe(0);
    });

    it('reports a seed whose decision throws instead of hiding the other twenty', () => {
        const score = scoreSeedCorpus({
            scenarios: [
                ...corpus.scenarios,
                {
                    id: 'a-broken-fixture',
                    mode: 'record',
                    why: 'fixture: the builder itself is wrong',
                    build: () => { throw new Error('the fixture cannot build its input'); },
                    expect: { verdict: 'pass', reasons: [] },
                },
            ],
        });
        expect(score.mismatched.map((entry) => entry.id)).toEqual(['a-broken-fixture']);
        expect(String(score.mismatched[0]?.decided.verdict)).toContain('the fixture cannot build its input');
        expect(score.cases).toBe(corpus.scenarios.length + 1);
    });

    it('says what it does not measure, so a green line is not read as a quality claim', () => {
        const score = scoreSeedCorpus(corpus);
        expect(score.measures).toContain('not whether it finds defects nobody planted');
        // And the coverage half is real: every reason the kernel can produce is exercised by some seed, which is what
        // keeps the vocabulary from growing silently.
        expect(score.reasonsUnexercised).toEqual([]);
        const allReasons = Object.keys(REASON_MESSAGES) as ReasonCode[];
        expect(score.reasonsExercised.length).toBe(allReasons.length);
    });
});
