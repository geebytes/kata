import { describe, expect, it } from 'vitest';
import { deriveVerdict, evaluateAdmissibility, type ReviewState } from '../../src/quality/review-state.js';
import { admissibilityCorpus, scoreCorpus } from '../../src/eval/admissibility-corpus.js';

/**
 * The judgment foundation: a conclusion is admissible only when each of its parts is checkable from the record.
 *
 * This is the root of the change, and it is narrower than "the prompt is too weak". The gate it replaces returned
 * `satisfied: true` on this condition, verbatim:
 *
 *     revision matches
 *     + status !== 'waived'
 *     + executedInFreshContext === true      ← agent assertion
 *     + briefSha256 was actually issued       ← real check
 *     + attempts.length > 0                   ← arity only, never content
 *     + no attempt cites an undeclared test   ← real check
 *     → satisfied
 *
 * `verdict` was never read. So the smallest record that passed a strict node was one declaring
 * `verdict: "inconclusive"` with an empty findings list — the reviewer stating *"I did not reach a conclusion"* and the
 * node passing anyway. The judgment foundation had no representation for "not concluded", which is a missing state
 * rather than a quality risk.
 *
 * The fix is not "check the verdict field": a field the reviewer can write is the same defect one level up. The reviewer
 * supplies hypotheses and observations; **kata derives the verdict from them**.
 */
describe('review admissibility', () => {
    /** A revision whose changed paths and criteria are what a state must cover. */
    const revision = {
        revisionId: 'revision-under-review',
        changedPaths: ['src/quality/adversarial.ts', 'tests/unit/review-admissibility.test.ts'],
        criterionIds: ['AC-1'],
    };

    /** A hypothesis that discharged itself against a readable source at this revision. */
    const discharged = (overrides: Partial<ReviewState['hypotheses'][number]> = {}): ReviewState['hypotheses'][number] => ({
        id: 'h1',
        claim: 'the gate reads the verdict',
        targets: ['AC-1', 'src/quality/adversarial.ts'],
        method: 'source-read',
        outcome: 'refuted',
        observation: {
            kind: 'source',
            ref: 'src/quality/adversarial.ts#L1043',
            observed: 'the satisfied branch returns before any read of record.verdict',
        },
        ...overrides,
    });

    const state = (overrides: Partial<ReviewState> = {}): ReviewState => ({
        coverage: [
            { criterionId: 'AC-1', paths: ['src/quality/adversarial.ts'] },
            { criterionId: null, paths: ['tests/unit/review-admissibility.test.ts'] },
        ],
        hypotheses: [discharged()],
        findings: [],
        ...overrides,
    });

    it('admits a state that covers the revision and discharges every hypothesis', () => {
        const result = evaluateAdmissibility(state(), revision);

        expect(result.admissible).toBe(true);
        expect(result.verdict).toBe('no_defect_found');
        expect(result.uncovered).toEqual([]);
        expect(result.ungrounded).toEqual([]);
    });

    it('refuses a state that reports no defect without covering a changed path', () => {
        // The defect the previous implementation shipped: a record with nothing in it passed a strict node.
        const result = evaluateAdmissibility(state({ coverage: [{ criterionId: 'AC-1', paths: [] }] }), revision);

        expect(result.admissible).toBe(false);
        expect(result.verdict).toBe('inconclusive');
        expect(result.uncovered).toContain('tests/unit/review-admissibility.test.ts');
        expect(result.reason).toMatch(/cover/i);
    });

    it('refuses a state that claims to have looked at nothing', () => {
        const result = evaluateAdmissibility(state({ hypotheses: [] }), revision);

        expect(result.admissible).toBe(false);
        expect(result.verdict).toBe('inconclusive');
        expect(result.reason).toMatch(/no hypothesis/i);
    });

    it('refuses a hypothesis with no readable observation, because a refuted assertion is not a discharge', () => {
        const result = evaluateAdmissibility(state({
            hypotheses: [discharged({ observation: undefined })],
        }), revision);

        expect(result.admissible).toBe(false);
        expect(result.verdict).toBe('inconclusive');
        // It lands in `open`, not `ungrounded`: a hypothesis with no observation did not discharge at all, whereas
        // `ungrounded` is specifically "an observation was cited and it does not resolve". Conflating the two would hide
        // which repair is needed — cite something, or cite something real.
        expect(result.open).toContain('h1');
        expect(result.ungrounded).toEqual([]);
        expect(result.reason).toMatch(/converge|observ/i);
    });

    it('refuses an observation that does not resolve at this revision', () => {
        // A citation that cannot be opened is prose with a path-like shape, which is the class the grounding conjunct
        // exists to exclude — and it is checked against the revision, not against the reviewer's confidence.
        const result = evaluateAdmissibility(state({
            hypotheses: [discharged({ observation: { kind: 'source', ref: 'src/quality/gone.ts#L1', observed: 'x' } })],
        }), revision);

        expect(result.admissible).toBe(false);
        expect(result.verdict).toBe('inconclusive');
        expect(result.ungrounded).toContain('h1');
    });

    it('derives defects_found when a hypothesis was confirmed, and keeps the finding', () => {
        const result = evaluateAdmissibility(state({
            hypotheses: [discharged({ id: 'h1', outcome: 'confirmed' })],
            findings: [{ id: 'f1', severity: 'major', message: 'the gate never reads the verdict', path: 'src/quality/adversarial.ts' }],
        }), revision);

        expect(result.admissible).toBe(true);
        expect(result.verdict).toBe('defects_found');
    });

    it('refuses a pass that confirms a critical defect and omits it from findings', () => {
        // The consistency conjunct: a state cannot confirm a defect and decline to report it, because that is the shape
        // where a real finding is used to decorate an answer while the deliverable stays unchanged.
        const result = evaluateAdmissibility(state({
            hypotheses: [discharged({ id: 'h1', outcome: 'confirmed' })],
            findings: [],
        }), revision);

        expect(result.admissible).toBe(false);
        expect(result.verdict).toBe('inconclusive');
        expect(result.reason).toMatch(/finding/i);
    });

    it('derives budget_exhausted when a hypothesis was abandoned to a limit, and names it', () => {
        // This is the state that replaces silent truncation: 81 truncations and a 2,627-second pass both used to
        // terminate as "satisfied with zero findings" whenever nothing was written down.
        const result = evaluateAdmissibility(state({
            hypotheses: [discharged(), discharged({ id: 'h2', outcome: 'abandoned', observation: undefined, abandoned: { limit: 'tools', why: 'the tool budget was reached' } })],
        }), revision);

        expect(result.admissible).toBe(false);
        expect(result.verdict).toBe('budget_exhausted');
        expect(result.abandoned).toEqual(['h2']);
        expect(result.reason).toMatch(/budget|limit/i);
    });

    it('derives the verdict rather than reading one, so a declared verdict cannot pass an incomplete state', () => {
        // The whole point: there is no field to declare it in. A state that claims `no_defect_found` in prose and covers
        // nothing is still refused, and the derived verdict ignores the claim entirely.
        const claimed = { ...state({ coverage: [] }), verdict: 'no_defect_found' } as ReviewState & { verdict: string };
        const result = evaluateAdmissibility(claimed, revision);

        expect(result.verdict).toBe('inconclusive');
        expect(result.admissible).toBe(false);
    });

    it('treats a hypothesis that did not converge as inconclusive rather than as a discharge', () => {
        // `outcome: inconclusive` is not a result: the hypothesis was neither refuted nor confirmed, so the conclusion
        // it belongs to cannot be certified while it is open.
        const result = evaluateAdmissibility(state({
            hypotheses: [discharged({ observation: undefined, outcome: 'inconclusive' })],
        }), revision);

        expect(result.verdict).toBe('inconclusive');
        expect(result.admissible).toBe(false);
        expect(result.open).toEqual(['h1']);
    });

    it('reports the deceased state names, so a caller can render why without re-deriving', () => {
        const result = evaluateAdmissibility(state({ coverage: [], hypotheses: [] }), revision);

        expect(result.verdict).toBe('inconclusive');
        expect(result.reason).toBeTruthy();
        expect(Array.isArray(result.uncovered)).toBe(true);
    });

    it('derives the verdict through a single exported function so the gate and the brief cannot disagree', () => {
        expect(deriveVerdict(state())).toBe('no_defect_found');
        expect(deriveVerdict(state({ hypotheses: [discharged({ outcome: 'abandoned', abandoned: { limit: 'time', why: 'x' } })] }))).toBe('budget_exhausted');
        expect(deriveVerdict(state({ hypotheses: [discharged({ outcome: 'confirmed' })], findings: [{ id: 'f', severity: 'major', message: 'm' }] }))).toBe('defects_found');
        expect(deriveVerdict(state({ hypotheses: [discharged({ observation: undefined })] }))).toBe('inconclusive');
    });

    it('scores the shape the old gate accepted as a false pass over the corpus', () => {
        // The corpus and the predicate must meet, or the referee measures something the change does not alter. This is
        // the join: the minimal record §2.1 identified (a reviewer stating "I did not reach a conclusion", which the old
        // gate accepted) is refused here, and the corpus independently counts that shape as a false pass.
        const minimal: ReviewState = { coverage: [], hypotheses: [], findings: [] };
        const verdict = evaluateAdmissibility(minimal, revision);
        expect(verdict.admissible).toBe(false);
        expect(verdict.verdict).toBe('inconclusive');

        const corpus = admissibilityCorpus();
        const blind = scoreCorpus(corpus, corpus.map((entry) => ({ caseId: entry.id, verdict: 'no_defect_found' as const, findingIds: [] })));
        expect(blind.criticalRecall).toBeLessThan(1);
        expect(blind.falsePassRate).toBeGreaterThan(0);
    });
});
