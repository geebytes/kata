import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { createTaskRevision } from '../../src/workflow/revision.js';
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

    it('reports the same verdict the gate derives, from the same function', async () => {
        // R7, found by an adversarial pass on 2026-09-22: `src/cli/ops.ts` carried a second, weaker derivation that read
        // only `abandoned` and the presence of an observation, never `outcome` — so a hypothesis that *confirmed* a
        // defect was reported as `no_defect_found`. The gate correctly refused the record while the CLI printed a verdict
        // contradicting it, and the operator read the wrong one.
        //
        // The property: kata derives the verdict once. A confirmed defect is `defects_found` in both places.
        const confirming: ReviewState = {
            coverage: [],
            hypotheses: [discharged({ outcome: 'confirmed' })],
            findings: [{ id: 'f1', severity: 'major', message: 'a defect' }],
        };
        expect(deriveVerdict(confirming)).toBe('defects_found');

        // And the CLI reports exactly that, rather than a projection of its own.
        const { runAdversarialCommand } = await import('../../src/cli/ops.js');
        const root = await mkdtemp(join(tmpdir(), 'kata-verdict-projection-'));
        try {
            await initLayout(root);
            await createTask({ root, id: 'verdict', title: 'Verdict', ownedPaths: ['src/'], acceptance: [{ id: 'AC-1', statement: 'x' }] });
            await mkdir(join(root, 'src'), { recursive: true });
            await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
            await createTaskRevision({ root, taskId: 'verdict', ownedPaths: ['src/a.ts'], checkIds: [] });
            const { issueAdversarialBrief, writeAdversarialRecord } = await import('../../src/quality/adversarial.js');
            const brief = await issueAdversarialBrief(root, 'verdict', 'review');
            await writeAdversarialRecord(root, 'verdict', {
                node: 'review',
                status: 'recorded',
                revisionId: brief.revisionId ?? '',
                createdAt: new Date().toISOString(),
                executedInFreshContext: true,
                briefSha256: brief.sha256,
                hypotheses: [{ id: 'h1', claim: 'c', targets: ['AC-1', 'src/a.ts'], method: 'source-read', outcome: 'confirmed', observation: { kind: 'source', ref: 'src/a.ts', observed: 'a defect' } }],
                findings: [{ id: 'f1', taskId: 'verdict', severity: 'major', message: 'a defect' }],
            } as never);
            const previousCwd = process.cwd();
            process.chdir(root);
            try {
                const status = await runAdversarialCommand(['status', '--change', 'verdict']);
                const node = (status.nodes as Record<string, Record<string, unknown>>).review!;
                expect(node.verdict).toBe('defects_found');
            } finally {
                process.chdir(previousCwd);
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }
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

    it('refuses a documented-shape record that carries no judgement basis at all', () => {
        // R2, found independently by two adversarial passes on 2026-09-22. The gate ran its predicate behind
        // `if (gate.record?.hypotheses)` — and `hypotheses` was absent from the schema's `required`, from the brief's
        // template and from both Skills. So the *documented* record (attempts + findings, no hypotheses) reached
        // satisfied:true with the entire coverage/discharge/grounding conjunct skipped, which is the shape AC-1 and AC-6
        // exist to refuse. Measured on the real change: its own recorded pass carried 10 attempts, 8 findings and no
        // hypotheses, so the predicate never ran on the pass that was supposed to be judged by it.
        //
        // The property is arity-neutral: a record with nothing to judge must be refused, not silently exempted.
        const noBasis: ReviewState = { coverage: [], hypotheses: [], findings: [] };
        expect(evaluateAdmissibility(noBasis, revision)).toMatchObject({ admissible: false });
    });

    it('refuses an empty coverage declaration rather than treating hypotheses alone as enough', () => {
        // Found while wiring §3.1.2 into the gate. The gate passed `coverage: [{criterionId: null, paths: []}]` — a
        // shape that claims nothing — and because coverage is computed as `hypotheses.targets ∪ declaration`, the
        // declaration contributed nothing and the *declaration half of the conjunct was effectively switched off* for
        // every real pass. Measured here, not assumed: the first run of this test expected `admissible: true` and got
        // `false`, which is the check telling me the field was inert rather than permissive.
        //
        // The contract this pins: an empty declaration is refused, and a declaration cannot substitute for
        // hypotheses — so §3.1.2's `coverage` conjunct cannot be satisfied by a caller filling in an array.
        const declaredNothing = evaluateAdmissibility(
            state({ coverage: [{ criterionId: null, paths: [] }] }),
            revision,
        );
        expect(declaredNothing.admissible).toBe(false);
        // The uncovered set is truthful, not empty: this state really did not cover the test file.
        expect(declaredNothing.uncovered).toEqual(['tests/unit/review-admissibility.test.ts']);
        expect(declaredNothing.reason).toMatch(/cover/i);

        // And the other direction: a declaration that names everything cannot stand in for having looked.
        const declaredEverything = evaluateAdmissibility(
            state({ coverage: [{ criterionId: 'AC-1', paths: [...revision.changedPaths] }], hypotheses: [] }),
            revision,
        );
        expect(declaredEverything.admissible).toBe(false);
        expect(declaredEverything.reason).toMatch(/no hypothesis/i);
    });

    it('refuses a pass whose hypotheses claim the criteria but no changed path, without a coverage declaration to hide behind', () => {
        // `targets` is the union coverage is computed from. A reviewer that speaks only for the criteria has not
        // looked at the code, and an empty `coverage` declaration must not be able to paper over that.
        const result = evaluateAdmissibility(
            state({ coverage: [], hypotheses: [discharged({ targets: ['AC-1'] })] }),
            revision,
        );

        expect(result.admissible).toBe(false);
        expect(result.uncovered).toEqual(['src/quality/adversarial.ts', 'tests/unit/review-admissibility.test.ts']);
    });

    it('refuses a graph result as a grounding observation, because navigation is not evidence', () => {
        // A graph result can focus a source read but cannot substitute for one: it is derived, may be stale, and is not
        // a revision-bound artefact. Keep the cast at this trust boundary so a future schema expansion cannot silently
        // promote `graph` to evidence without making this test fail.
        const graphOnly = evaluateAdmissibility(
            state({
                hypotheses: [discharged({
                    observation: { kind: 'graph' as never, ref: 'symbol:adversarialGateFor', observed: 'a caller edge' },
                })],
            }),
            revision,
        );
        expect(graphOnly.admissible).toBe(false);
        expect(graphOnly.ungrounded).toEqual(['h1']);
    });
});

/**
 * §4 Phase 1: `verdict` is **removed** from the record and computed by Kata.
 *
 * "Derived, never read" is weaker than the design asks for. As long as the field exists, two sources for one fact exist,
 * and the reviewer-written one is the cheaper to reach — the shape a later caller can accidentally trust. The migration
 * is the part that must be handled honestly: `additionalProperties: false` means deleting the field outright would
 * refuse every already-written record, so what a legacy record means has to be stated rather than assumed.
 */
describe('the reviewer cannot write a verdict', () => {
    it('names `verdict` on a record as a retired field rather than silently accepting it', async () => {
        const { retiredRecordFields } = await import('../../src/quality/adversarial.js');
        expect(typeof retiredRecordFields).toBe('function');
        // Present: reported, so a legacy record is migrated rather than reinterpreted as if the field were meaningful.
        expect(retiredRecordFields({ verdict: 'no_defect_found' })).toEqual(['verdict']);
        // Absent: nothing to report.
        expect(retiredRecordFields({ hypotheses: [] })).toEqual([]);
    });
});
