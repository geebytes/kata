import { describe, expect, it } from 'vitest';
import { scoreWithKernel } from '../../src/eval/kernel-verifier.js';
import { kernelCaseBuilders, NOT_EXPRESSIBLE } from '../../src/eval/kernel-case-builders.js';
import { admissibilityCorpus } from '../../src/eval/admissibility-corpus.js';

/**
 * **The recall measurement, run against the kernel, with its limits on the output.**
 *
 * Recall has been unmeasurable because nothing produced `CorpusObservation`s. The kernel cannot produce finding ids and
 * this scorer does not pretend it can: it answers the question behind the metric — given the state a case describes, does
 * the mechanism refuse to certify it — over the cases whose state is expressible as a kernel input, and it names the rest.
 *
 * What the first run of it found, which is the reason it was worth building: two cases the kernel answered `pass`.
 * One was a real defect in `delta.ts` (resolvability was checked on one of two paths, and the flag it set was read by
 * nobody) — repaired. The other is a real capability gap (an injected assertion is shape-valid evidence; the new kernel
 * has no concept of text offered as authority), and it stays on the record rather than being explained away.
 */
describe('the kernel scored against the retired corpus', () => {
    const { builders, notExpressible } = kernelCaseBuilders();
    const score = scoreWithKernel({ builders, notExpressible: [...notExpressible] });

    it('scores only the cases whose state a pure function can be handed, and names the rest', () => {
        const corpusIds = new Set(admissibilityCorpus().map((entry) => entry.id));
        // Both directions: a builder for a case that does not exist, and a case with neither a builder nor a reason.
        for (const id of builders.keys()) expect(corpusIds.has(id), `${id} is not a corpus case`).toBe(true);
        for (const entry of notExpressible) expect(corpusIds.has(entry.caseId), `${entry.caseId} is not a corpus case`).toBe(true);
        const covered = new Set([...builders.keys(), ...notExpressible.map((entry) => entry.caseId)]);
        const unaccounted = [...corpusIds].filter((id) => !covered.has(id));
        expect(unaccounted, 'every case is either built or given a reason').toEqual([]);
        for (const entry of notExpressible) expect(entry.why).not.toHaveLength(0);
        expect(score.cases).toBe(builders.size);
    });

    it('reports the population each rate is over, so a subset cannot read as the whole corpus', () => {
        expect(score.criticalCases).toBeGreaterThan(0);
        expect(score.criticalCases).toBeLessThan(admissibilityCorpus().length);
        expect(score.measures).toContain('not whether a pass would have found the defect');
        expect(score.measures).toContain('not finding ids');
    });

    it('counts a false pass separately from a refusal, and names the cases', () => {
        // The one metric `docs/verfify.md` puts above the others. It is reported as a list of case ids rather than only a
        // rate, because a reader acts on which case was missed.
        expect(Array.isArray(score.falsePasses)).toBe(true);
        expect(score.falsePassRate).toBeCloseTo(score.falsePasses.length / score.criticalCases, 5);
    });

    it('does not count a missing reason as an answer, for the case that needs one', () => {
        // `budget_exhausted` maps to `insufficient` like `inconclusive` does, so the verdict alone does not answer the
        // case: the reason has to be there. Without this the two would be indistinguishable and the mapping would be
        // reporting a coincidence as a match.
        expect(score.answers.find((answer) => answer.caseId === 'budget-exhaustion-is-reported-not-silent')?.matched).toBe(true);
        const withoutReason = scoreWithKernel({
            builders: new Map([['budget-exhaustion-is-reported-not-silent', () => null]]),
            notExpressible: [],
        });
        expect(withoutReason.cases).toBe(0);
    });
});
