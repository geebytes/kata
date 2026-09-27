/**
 * The referee: the seed corpus of the new mechanism's own failure modes, decided by the mechanism itself.
 *
 * Two corpora existed and had no connection. `src/eval/admissibility-corpus.ts` is scored by the old eval path from a
 * hand-written manifest of observations — 27 cases about the round-shaped verifier. `tests/fixtures/review-scenarios.ts`
 * is the new mechanism's own twenty-odd failure modes, and until now the only thing that read them was one unit test. So
 * the question "what does this mechanism decide on the corpus of its own failure modes, and where does it disagree with
 * what the seed says should happen" had no answer, which is part of why the plan's acceptance criteria say *not
 * measurable* rather than *passing*.
 *
 * The scoring is deliberately literal and has three parts:
 *
 *  - **verdict** — what `decide` returned, against what the seed expects. A disagreement is a **mismatch**, named with
 *    both sides, because that is either a defect in the mechanism or a wrong expectation and the tool must not decide
 *    which.
 *  - **reasons** — the codes the seed requires must all be present. A missing one means the mechanism reached the right
 *    verdict for a reason nobody wrote down, which is the "a check cannot fail" class at the level of a whole decision.
 *  - **coverage** — every reason the kernel can produce must appear in some seed, so the vocabulary cannot grow silently.
 *
 * What it is not: a recall measurement. These are seeds with known expected answers, so a pass here proves the mechanism
 * decides as specified — not that it finds defects nobody planted. That distinction is on the output as `measures`, so a
 * green line cannot be read as a quality claim.
 */
import { decide } from '../kernel/decide.js';
import { REASON_MESSAGES, type ReasonCode } from '../kernel/types.js';
import type { DecideInput } from '../kernel/decide.js';

export type SeedOutcome = {
    id: string;
    mode: string;
    expected: { verdict: string; reasons: string[] };
    decided: { verdict: string; reasons: string[] };
    /** Why this seed is in the corpus, carried out so a report is readable without opening the fixture. */
    why: string;
    /** The required reasons the decision did not carry. */
    missing: string[];
    matched: boolean;
};

export type SeedScore = {
    cases: number;
    matched: number;
    mismatched: SeedOutcome[];
    /** Verdicts by the outcome the mechanism reached, so a change in the shape of the corpus is visible as a trend. */
    byVerdict: Record<string, number>;
    /** Every reason the corpus exercises, and the codes no seed reaches. */
    reasonsExercised: string[];
    reasonsUnexercised: string[];
    measures: string;
};

/** The corpus and the decision under test, injected so the CLI does not import a fixture and a test can supply its own. */
export type SeedScorer = {
    scenarios: Array<{
        id: string;
        mode: string;
        why: string;
        build: () => DecideInput;
        expect: { verdict: string; reasons: string[] };
    }>;
};

/**
 * Score the seeds.
 *
 * A seed whose decision throws is reported as a mismatch rather than aborting the run: one broken fixture must not hide
 * the other twenty.
 */
export function scoreSeedCorpus(corpus: SeedScorer): SeedScore {
    const outcomes: SeedOutcome[] = corpus.scenarios.map((scenario) => {
        let decision: { verdict: string; reasons: string[] };
        try {
            const result = decide(scenario.build());
            decision = { verdict: result.verdict, reasons: result.reasons.map((reason) => reason.code) };
        } catch (error) {
            decision = { verdict: `threw: ${(error as Error).message}`, reasons: [] };
        }
        const missing = scenario.expect.reasons.filter((code) => !decision.reasons.includes(code));
        return {
            id: scenario.id,
            mode: scenario.mode,
            expected: { verdict: scenario.expect.verdict, reasons: scenario.expect.reasons },
            decided: decision,
            why: scenario.why,
            missing,
            matched: decision.verdict === scenario.expect.verdict && missing.length === 0,
        };
    });

    const byVerdict: Record<string, number> = {};
    for (const outcome of outcomes) byVerdict[outcome.decided.verdict] = (byVerdict[outcome.decided.verdict] ?? 0) + 1;

    const exercised = new Set(outcomes.flatMap((outcome) => outcome.decided.reasons));
    const allReasons = Object.keys(REASON_MESSAGES) as ReasonCode[];

    return {
        cases: outcomes.length,
        matched: outcomes.filter((outcome) => outcome.matched).length,
        mismatched: outcomes.filter((outcome) => !outcome.matched),
        byVerdict,
        reasonsExercised: [...exercised].sort(),
        reasonsUnexercised: allReasons.filter((code) => !exercised.has(code)).sort(),
        measures: 'whether the mechanism decides as its own seeds specify — not whether it finds defects nobody planted',
    };
}

/**
 * Score the repository's seed corpus.
 *
 * The fixture is loaded dynamically: it imports the test helpers, and a production module importing a test helper would
 * make the helper part of the product's dependency graph. A corpus that cannot be loaded is reported as such rather than
 * as an empty one — the same rule the ledger applies to its own files.
 */
export async function scoreSeeds(): Promise<SeedScore> {
    const module = await import('../../tests/fixtures/review-scenarios.js') as unknown as { reviewScenarios: SeedScorer['scenarios'] };
    return scoreSeedCorpus({ scenarios: module.reviewScenarios });
}
