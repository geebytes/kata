/**
 * The kernel as the verifier: score the retired corpus with `decide`, without pretending to produce finding ids.
 *
 * **Why this exists.** Recall has been unmeasurable because nothing produced `CorpusObservation`s — that needs a verifier
 * that reports finding ids. It does not exist, and inventing one would make the measurement a description of the invention.
 * What the kernel *can* answer is the question behind the metric: given the state a corpus case describes, does the
 * mechanism refuse to certify it? So the mapping is stated once and is deliberately coarse:
 *
 * | corpus verdict | the kernel's answer |
 * |---|---|
 * | `no_defect_found` | `pass` — nothing to refuse |
 * | `defects_found` | `fail` — a refuted claim or an unresolved counterexample |
 * | `inconclusive` | `insufficient` |
 * | `budget_exhausted` | `insufficient` carrying `budget_exhausted` |
 *
 * `criticalRecall` is then the share of `defects_found` cases the kernel answers `fail`; `falsePassRate` is the share it
 * answers `pass` — the one `docs/verfify.md` puts above every other, because a miss is invisible.
 *
 * **Three limits, stated on the output rather than implied.** ① It scores the cases whose state is *expressible as a
 * kernel input*, and the rest are listed with a reason — a score over four of nine critical cases must not read as a
 * score over nine. ② It is not a reviewer: `decide` is a pure function over a state, so this measures the **judgement**,
 * not whether a pass would have found the defect. ③ Finding ids are not produced, so a case whose expectation names
 * specific findings is scored on its verdict alone, and the output says which cases those are.
 */
import { decide, type DecideInput } from '../kernel/decide.js';
import { admissibilityCorpus, type CorpusCase } from './admissibility-corpus.js';

export type KernelCaseAnswer = {
    caseId: string;
    expected: string;
    answered: string;
    matched: boolean;
    /** The kernel's reason codes, so a disagreement can be read rather than only counted. */
    reasons: string[];
    /** Whether the case's expectation named specific findings, which a verdict-only scorer cannot check. */
    verdictOnly: boolean;
};

export type KernelVerifierScore = {
    cases: number;
    /** Critical cases whose expectation is `defects_found`: the population recall is measured over. */
    criticalCases: number;
    refused: number;
    criticalRecall: number;
    /** Critical cases the kernel answered `pass` — the metric above all others. */
    falsePasses: string[];
    falsePassRate: number;
    /** The cases this scorer does not reach, each with the reason. */
    notExpressible: Array<{ caseId: string; why: string }>;
    /**
     * Cases whose subject no longer exists, each with the reason.
     *
     * Separate from `notExpressible` because the reasons differ and so does the remedy: `notExpressible` means "a pure
     * function cannot be handed this state", and this means "the state no longer exists to be handed". Reported so a
     * population that shrank is a stated fact rather than a smaller denominator nobody can see.
     */
    retired: Array<{ caseId: string; why: string }>;
    answers: KernelCaseAnswer[];
    measures: string;
};

/** Build the kernel input a case describes, or `null` when the case's state is not expressible as one. */
export type CaseBuilder = (entry: CorpusCase) => DecideInput | null;

const VERDICT_TO_KERNEL: Record<string, 'pass' | 'fail' | 'insufficient'> = {
    no_defect_found: 'pass',
    defects_found: 'fail',
    inconclusive: 'insufficient',
    budget_exhausted: 'insufficient',
};

/**
 * Score the retired corpus against a set of builders.
 *
 * The builders are passed in rather than derived: a case's `reproduction` is prose about what a reader should do, and
 * turning prose into a kernel input by parsing it would be the "interpret the text to derive a fact" class this
 * repository keeps removing. A case with no builder is reported as not expressible, with the reason the caller supplies.
 */
export function scoreWithKernel(input: {
    builders: ReadonlyMap<string, CaseBuilder>;
    notExpressible: Array<{ caseId: string; why: string }>;
    retired?: Array<{ caseId: string; why: string }>;
    corpus?: CorpusCase[];
}): KernelVerifierScore {
    const corpus = input.corpus ?? admissibilityCorpus();
    const answers: KernelCaseAnswer[] = [];

    for (const entry of corpus) {
        const build = input.builders.get(entry.id);
        if (build === undefined) continue;
        let built: DecideInput | null;
        try {
            built = build(entry);
        } catch (error) {
            answers.push({
                caseId: entry.id,
                expected: entry.expectedVerdict,
                answered: `threw: ${(error as Error).message}`,
                matched: false,
                reasons: [],
                verdictOnly: entry.expectedFindings.length > 0,
            });
            continue;
        }
        if (built === null) continue;
        const decision = decide(built);
        const answered = decision.verdict;
        const expected = VERDICT_TO_KERNEL[entry.expectedVerdict];
        const reasons = decision.reasons.map((reason) => reason.code);
        // `budget_exhausted` is the one case where the coarse mapping needs the reason: both sides say `insufficient`, and
        // a budget case answered `insufficient` for an unrelated reason has not answered the case.
        const budgetOk = entry.expectedVerdict !== 'budget_exhausted' || reasons.includes('budget_exhausted');
        answers.push({
            caseId: entry.id,
            expected: entry.expectedVerdict,
            answered,
            matched: answered === expected && budgetOk,
            reasons,
            verdictOnly: entry.expectedFindings.length > 0,
        });
    }

    // The population both rates are over: critical cases whose expectation is `defects_found`, **excluding retired ones**.
    // A retired case has no builder and would be dropped from `answers` anyway, but naming the exclusion here keeps the
    // denominator and the report saying the same thing — a smaller population must be visible, not inferred from a count.
    const retired = input.retired ?? [];
    const retiredIds = new Set(retired.map((entry) => entry.caseId));
    const criticalIds = new Set(
        corpus
            .filter((entry) => entry.critical === true && entry.expectedVerdict === 'defects_found' && !retiredIds.has(entry.id))
            .map((entry) => entry.id),
    );
    const scoredCritical = answers.filter((answer) => criticalIds.has(answer.caseId));
    const refused = scoredCritical.filter((answer) => answer.answered === 'fail');
    const falsePasses = scoredCritical.filter((answer) => answer.answered === 'pass');

    return {
        cases: answers.length,
        criticalCases: scoredCritical.length,
        refused: refused.length,
        // A rate with no population is reported as zero over zero **and** the population is printed: an empty measurement
        // must not look like a perfect one.
        criticalRecall: scoredCritical.length === 0 ? 0 : refused.length / scoredCritical.length,
        falsePasses: falsePasses.map((answer) => answer.caseId),
        falsePassRate: scoredCritical.length === 0 ? 0 : falsePasses.length / scoredCritical.length,
        notExpressible: input.notExpressible,
        retired,
        answers,
        measures: 'the kernel\'s judgement on the cases whose state is expressible as a kernel input — not whether a pass would have found the defect, and not finding ids',
    };
}
