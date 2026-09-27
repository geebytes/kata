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
    const { builders, notExpressible, retired } = kernelCaseBuilders();
    const score = scoreWithKernel({ builders, notExpressible: [...notExpressible], retired: [...retired] });

    it('scores only the cases whose state a pure function can be handed, and names the rest', () => {
        const corpusIds = new Set(admissibilityCorpus().map((entry) => entry.id));
        // Both directions: a builder for a case that does not exist, and a case with neither a builder nor a reason.
        for (const id of builders.keys()) expect(corpusIds.has(id), `${id} is not a corpus case`).toBe(true);
        for (const entry of [...notExpressible, ...retired]) expect(corpusIds.has(entry.caseId), `${entry.caseId} is not a corpus case`).toBe(true);
        // **Three lists, not two.** A case is built, not expressible, or retired — and a case in none of them is a silent
        // hole. The retired list exists because a case whose subject was deleted cannot be built *or* described as an
        // inexpressible state: it had a builder, and that builder was answering a question the case no longer asks.
        const covered = new Set([...builders.keys(), ...notExpressible.map((entry) => entry.caseId), ...retired.map((entry) => entry.caseId)]);
        const unaccounted = [...corpusIds].filter((id) => !covered.has(id));
        expect(unaccounted, 'every case is built, given a reason, or marked retired').toEqual([]);
        for (const entry of [...notExpressible, ...retired]) expect(entry.why).not.toHaveLength(0);
        expect(score.cases).toBe(builders.size);
        expect(score.retired).toEqual([...retired]);
    });

    it('does not let a retired subject keep a builder that would answer for it', () => {
        // The defect a live run found: `obligation-resolution-mutation` had a builder returning a refuted falsifier, so the
        // kernel answered `fail` and the scorer reported `matched: true` — for a defect whose module and suite had been
        // deleted. A case with no subject must produce no answer, and the exclusion must be visible in the report.
        expect(retired.map((entry) => entry.caseId)).toContain('obligation-resolution-mutation');
        expect(builders.has('obligation-resolution-mutation')).toBe(false);
        expect(score.answers.some((answer) => answer.caseId === 'obligation-resolution-mutation')).toBe(false);
        // The population recall is measured over is the *scored* critical set — the cases that are critical, expect
        // `defects_found`, and have a builder. Spelled out rather than compared to the corpus total, because the gap
        // between them is exactly the thing this case is about.
        const scoredPopulation = admissibilityCorpus()
            .filter((entry) => entry.critical === true && entry.expectedVerdict === 'defects_found' && builders.has(entry.id))
            .length;
        expect(score.criticalCases).toBe(scoredPopulation);
        expect(score.criticalCases).toBeLessThan(admissibilityCorpus().filter((entry) => entry.critical === true).length);
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
