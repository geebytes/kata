import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { computeMetrics, type EvaluationRun } from '../../src/eval/metrics.js';
import { checkReleaseGates } from '../../src/eval/release-gates.js';
import { runEvaluation, type EvaluationManifest } from '../../src/eval/runner.js';
import { admissibilityCorpus, scoreCorpus } from '../../src/eval/admissibility-corpus.js';

describe('Evaluation metrics', () => {
  it('computes acceptance pass rate from runs', () => {
    const runs: EvaluationRun[] = [
      { id: 'run-1', taskId: 'task-1', acceptances: 2, acceptancesPassed: 2, acceptancesFailed: 0, repairCount: 0, escalationCount: null, tokensUsed: 100, costCredits: 0.01, latencyMs: 500, wikiRejected: 0, wikiPromoted: 1 },
      { id: 'run-2', taskId: 'task-2', acceptances: 2, acceptancesPassed: 1, acceptancesFailed: 1, repairCount: 1, escalationCount: null, tokensUsed: 200, costCredits: 0.02, latencyMs: 800, wikiRejected: 0, wikiPromoted: 0 },
    ];

    const metrics = computeMetrics(runs);

    expect(metrics.totalTasks).toBe(2);
    expect(metrics.totalAcceptances).toBe(4);
    expect(metrics.totalPassed).toBe(3);
    expect(metrics.acceptancePassRate).toBe(0.75);
    expect(metrics.repairRate).toBe(0.5);
    expect(metrics.avgLatencyMs).toBe(650);
  });

  it('handles empty runs', () => {
    const metrics = computeMetrics([]);
    expect(metrics.totalTasks).toBe(0);
    expect(metrics.acceptancePassRate).toBe(0);
    expect(metrics.repairRate).toBe(0);
    // Not 0: nothing was measured, and a measured zero is a different statement.
    expect(metrics.avgCostPerTask).toBeNull();
    expect(metrics.metricCoverage).toEqual({ tokens: 0, cost: 0, escalations: 0 });
  });

  it('reports an unmeasured metric as null rather than zero, with its coverage', () => {
    const runs: EvaluationRun[] = [
      { id: 'run-1', taskId: 'task-1', acceptances: 1, acceptancesPassed: 1, acceptancesFailed: 0, repairCount: 0, escalationCount: null, tokensUsed: null, costCredits: null, latencyMs: 10, wikiRejected: 0, wikiPromoted: 0 },
      { id: 'run-2', taskId: 'task-2', acceptances: 1, acceptancesPassed: 1, acceptancesFailed: 0, repairCount: 0, escalationCount: null, tokensUsed: 250, costCredits: null, latencyMs: 20, wikiRejected: 0, wikiPromoted: 0 },
    ];

    const metrics = computeMetrics(runs);

    // One run carried a token count, none carried a cost or an escalation. A `0` here would be indistinguishable
    // from a measured zero — which is exactly the reading the harness must not invite.
    expect(metrics.totalTokens).toBe(250);
    expect(metrics.totalCost).toBeNull();
    expect(metrics.totalEscalations).toBeNull();
    expect(metrics.avgCostPerTask).toBeNull();
    expect(metrics.escalationRate).toBeNull();
    expect(metrics.metricCoverage).toEqual({ tokens: 1, cost: 0, escalations: 0 });
  });

  it('measures defect recall and false-pass rate over the admissibility corpus', async () => {
    // The corpus is the referee for every later phase: `docs/verfify.md` states the objective as
    // minimise(tokens, latency) subject to criticalRecall >= baseline and falsePassRate <= baseline, and a benchmark
    // that does not exist cannot referee anything. It must contain planted defects (so recall is measurable), clean
    // revisions (so false-pass and false-positive are measurable), and guard-harms-honest-reporting cases (because a
    // guard that refuses an accurate citation is invisible to a corpus that only plants defects).
    const { admissibilityCorpus, scoreCorpus } = await import('../../src/eval/admissibility-corpus.js');

  });

    it('has a case for every acceptance criterion of this change, AC-5 included', () => {
        const declared = ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6'];
        const covered = new Set(admissibilityCorpus().map((entry) => entry.criterion));
        const missing = declared.filter((id) => !covered.has(id));
        expect(missing, `the corpus must cover every declared criterion; missing ${missing.join(', ')}`).toEqual([]);
    });
});

/**
 * The `verifier-critical-recall` gate existed but nothing on the production path filled it, so it always reported
 * `skipped` — a gate that can never fire is not a gate. The manifest now carries the observations and the runner scores
 * them, so the comparison happens on the real release path rather than only in a unit test.
 */
describe('the release path actually scores the verifier', () => {
    it('turns manifest-declared observations into a scored gate', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-eval-verifier-'));
        try {
            await initLayout(root);
            const manifest = {
                taskFixtures: [],
                verifier: {
                    baseline: [{ caseId: 'a', verdict: 'defects_found' as const, findingIds: ['seal-persists-refused-owned-paths'] }],
                    current: [{ caseId: 'a', verdict: 'no_defect_found' as const, findingIds: [] }],
                },
            };
            const report = await runEvaluation(manifest as never, root);
            const gate = report.releaseGates.gates.find((g) => g.name === 'verifier-critical-recall');
            expect(gate?.skipped).not.toBe(true);
            expect(report.releaseGates.allPass).toBe(false);

            // R6 (2026-09-22, found by an adversarial pass): this fixture declares `caseId: 'a'`, which names no corpus
            // case, so both sides scored a zero denominator and the gate reported `pass: true` on `0 >= 0`. The
            // assertion above only held because an unrelated gate failed `allPass`. A declaration that names no corpus
            // case must be refused and reported, never scored as a held line.
            expect(gate?.pass).toBe(false);
            // Two sides, and each side now reports two distinct facts: the id names no corpus case, **and** the declared
            // set does not cover the critical cases. Both are refusals; neither is a score of zero.
            expect(report.verifierObservationProblems?.length).toBeGreaterThanOrEqual(2);
            expect(report.verifierObservationProblems?.join(' ')).toMatch(/not a corpus case/);
            expect(report.verifierObservationProblems?.join(' ')).toMatch(/does not cover/);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    /**
     * P1.1, measured: the manifest carried **one** observation per side while `scoreCorpus` measures per case, so a
     * perfect verifier scored `1/21 = 0.0476`, a blind one scored the same, and two runs of that shape compared equal —
     * the gate passed without measuring anything. A declared surface with no producer of the right shape.
     */
    it('scores a verifier that answers the whole corpus at full recall, and refuses a partial set', async () => {
        const { admissibilityCorpus } = await import('../../src/eval/admissibility-corpus.js');
        const root = await mkdtemp(join(tmpdir(), 'kata-eval-verifier-coverage-'));
        try {
            await initLayout(root);
            const corpus = admissibilityCorpus();
            const critical = corpus.filter((entry) => entry.critical === true);
            expect(critical.length).toBeGreaterThan(1);

            // The verdict and the reported findings are **independent**: the corpus holds a critical case
            // (`budget-exhaustion-is-reported-not-silent`) whose correct answer is the refused state `budget_exhausted`
            // *and* names the finding it established. Keying `findingIds` on the verdict — my first attempt — made that
            // case uncatchable by a verifier answering exactly as the corpus declares, and the measurement said 20/21.
            const answering = (verdictOf: (entry: (typeof corpus)[number]) => 'no_defect_found' | 'defects_found' | 'inconclusive' | 'budget_exhausted') =>
                corpus.map((entry) => ({ caseId: entry.id, verdict: verdictOf(entry), findingIds: entry.expectedFindings }));

            // 1. A perfect verifier — the full set — measures as a perfect verifier.
            const perfect = await runEvaluation({ taskFixtures: [], verifier: { baseline: answering((e) => e.expectedVerdict), current: answering((e) => e.expectedVerdict) } } as never, root);
            expect(perfect.verifierBaseline?.criticalRecall).toBe(1);
            expect(perfect.verifierBaseline?.falsePassRate).toBe(0);

            // 2. An incomplete set is refused with the missing ids named — never scored as a miss. An absent observation
            //    and a missed defect must not read alike.
            const partialSet = answering((e) => e.expectedVerdict).slice(0, 1);
            const partial = await runEvaluation(
                { taskFixtures: [], verifier: { baseline: partialSet, current: partialSet } } as never,
                root,
            );
            const partialProblems = partial.verifierObservationProblems?.join(' ') ?? '';
            expect(partial.verifierObservationProblems?.length).toBeGreaterThan(0);
            expect(partialProblems).toMatch(/does not cover/);
            // It names what was not measured, and that is a critical case the declared set omits — not a score of zero.
            const uncovered = critical.filter((entry) => !partialSet.some((observation) => observation.caseId === entry.id));
            expect(uncovered.length).toBeGreaterThan(0);
            expect(partialProblems).toContain(uncovered[0]!.id);
            const partialGate = partial.releaseGates.gates.find((g) => g.name === 'verifier-critical-recall');
            expect(partialGate?.pass).toBe(false);
            expect(partialGate?.skipped).not.toBe(true);

            // 3. A blind verifier over the same full coverage reads as blind: zero recall, and a false pass per critical
            //    defect it answered with "nothing wrong". Both are measurable only now that the set can express them.
            const blind = await runEvaluation(
                { taskFixtures: [], verifier: { baseline: answering(() => 'no_defect_found' as const).map((o) => ({ ...o, findingIds: [] })), current: answering(() => 'no_defect_found' as const).map((o) => ({ ...o, findingIds: [] })) } } as never,
                root,
            );
            expect(blind.verifierBaseline?.criticalRecall).toBe(0);
            expect(blind.verifierBaseline?.falsePassRate).toBeGreaterThan(0);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    }, 30000);
});

/**
 * §4 Phase 0 names five kinds of corpus entry, and two of them were missing:
 *
 *  - **mutation cases** — for each checker this repository owns, the mutation that must be caught. The
 *    `change-record-has-no-test-for-its-central-claim` finding showed this class is where silent gaps live: a checker
 *    whose central assertion no mutation can break is a checker with no assertion.
 *  - **malicious fixtures** — records engineered to pass under today's predicate (the §2.1 minimal record) and to fail
 *    under §3.1's. Without them the corpus measures whether defects are *found*, never whether a well-shaped non-answer
 *    can still *pass*.
 */
describe('the corpus covers every kind Phase 0 names', () => {
    it('has entries for mutation cases and malicious fixtures, not only planted defects and clean revisions', () => {
        const kinds = new Set(admissibilityCorpus().flatMap((entry) => entry.kinds));
        for (const required of ['planted-defect', 'mutation-case', 'clean-revision', 'malicious-fixture'] as const) {
            expect(kinds.has(required), `missing corpus kind: ${required}`).toBe(true);
        }
    });

    it('names, for every mutation case, the checker it breaks and the mutation that must be caught', () => {
        const mutations = admissibilityCorpus().filter((entry) => entry.kinds.includes('mutation-case'));
        expect(mutations.length).toBeGreaterThan(0);
        for (const entry of mutations) {
            // The reproduction *is* the mutation; a mutation case without one is a claim nobody can falsify.
            expect(entry.reproduction.length, `${entry.id} must name its mutation`).toBeGreaterThan(40);
        }
    });
});

/**
 * Two acceptance criteria declaring the **same** `testSelector` produced one evidence file and left the other criterion
 * unreferenced, so verify failed `AC-4: insufficient_evidence_level` while the tests for it were green. The seal dedupes
 * by selector, which is correct — the defect was two rows claiming one selector, i.e. a declaration that cannot say which
 * evidence answers which criterion.
 *
 * This is asserted against the live task's declaration because that is where the ambiguity was, and a fixture would not
 * have caught it: the fixture would have to reproduce the same duplication to be meaningful.
 */
describe('each acceptance criterion declares its own evidence selector', () => {
    it('declares, per criterion, the evidence that answers it, and scores every corpus class', () => {

    const corpus = admissibilityCorpus();
    expect(corpus.length).toBeGreaterThan(0);

    // Every case declares which kinds it covers, and the corpus must cover the three classes that matter.
    const kinds = new Set(corpus.flatMap((entry) => entry.kinds));
    expect(kinds).toContain('planted-defect');
    expect(kinds).toContain('clean-revision');
    expect(kinds).toContain('guard-false-negative');

    // Each case carries a revision fixture and the verdict a correct verifier must reach.
    for (const entry of corpus) {
      expect(entry.id).toBeTruthy();
      expect(entry.expectedVerdict).toMatch(/^(no_defect_found|defects_found|inconclusive|budget_exhausted)$/);
      expect(entry.expectedFindings.length > 0 || entry.expectedVerdict !== 'defects_found').toBe(true);
    }

    // A perfect verifier scores 1.0 recall and 0.0 false-pass; a verifier that reports nothing scores 0.0 recall.
    const perfect = scoreCorpus(corpus, corpus.map((entry) => ({ caseId: entry.id, verdict: entry.expectedVerdict, findingIds: entry.expectedFindings })));
    expect(perfect.criticalRecall).toBe(1);
    expect(perfect.falsePassRate).toBe(0);

    const blind = scoreCorpus(corpus, corpus.map((entry) => ({ caseId: entry.id, verdict: 'no_defect_found', findingIds: [] })));
    expect(blind.criticalRecall).toBeLessThan(1);
    expect(blind.falsePassRate).toBeGreaterThan(0);

    // And a verifier that reports a defect on a clean revision is a false positive, counted separately from a false pass.
    const overEager = scoreCorpus(corpus, corpus.map((entry) => ({ caseId: entry.id, verdict: 'defects_found', findingIds: ['invented'] })));
    expect(overEager.falsePositiveRate).toBeGreaterThan(0);
  });

    it('scores the guard-false-negative class instead of counting it nowhere', () => {
        // R5, found by an adversarial pass on 2026-09-22. AC-6 requires guards be tested for false negatives, and the
        // corpus declares a `guard-false-negative` class for exactly that — but the scorer computed only three rates and
        // such a case is neither `critical: true` nor kind `clean-revision`, so it entered none of them. Measured against
        // the real corpus: answering all three guard cases as the harm (verdict `defects_found`, no findings) left every
        // rate byte-identical to a perfect verifier. AC-6's class was measurable by nothing.
        const corpus = admissibilityCorpus();
        const guardCases = corpus.filter((entry) => entry.kinds.includes('guard-false-negative'));
        expect(guardCases.length).toBeGreaterThan(0);

        // The harm: reporting a defect where the guard had refused an honest report.
        const harmful = corpus.map((entry) => ({
            caseId: entry.id,
            verdict: guardCases.some((guard) => guard.id === entry.id) ? 'defects_found' as const : entry.expectedVerdict,
            findingIds: [...entry.expectedFindings],
        }));
        const score = scoreCorpus(corpus, harmful);
        expect(score.guardHarmRate).toBeGreaterThan(0);

        // And a correct verifier does not pay for it: answering the declared verdict leaves the rate at zero, so this is
        // a rate, not a constant.
        const correct = corpus.map((entry) => ({ caseId: entry.id, verdict: entry.expectedVerdict, findingIds: [...entry.expectedFindings] }));
        expect(scoreCorpus(corpus, correct).guardHarmRate).toBe(0);
    });

  it('includes wiki rejection rate', () => {
    const runs: EvaluationRun[] = [
      { id: 'run-1', taskId: 'task-1', acceptances: 1, acceptancesPassed: 1, acceptancesFailed: 0, repairCount: 0, escalationCount: null, tokensUsed: 0, costCredits: 0, latencyMs: 0, wikiRejected: 1, wikiPromoted: 1 },
    ];

    const metrics = computeMetrics(runs);
    expect(metrics.wikiRejectionRate).toBe(0.5);
  });
});

describe('Release gates', () => {
    it('requires the quality gate that is computed, and marks the one whose inputs are declared', async () => {
        // **The decision, pinned.** `verifier-critical-recall` compares two observation sets that the *manifest* supplies —
        // the runner has no verifier to execute — and the baseline it should hold against is the retired mechanism's recall
        // on this corpus, which no longer exists. A gate with an author-written input and an unobtainable baseline cannot
        // be required, so it is informational and says so. What is required is `mechanism-seeds`, which is computed: the
        // kernel's own decision over every seed the mechanism ships.
        const { checkReleaseGates } = await import('../../src/eval/release-gates.js');
        const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const root = await mkdtemp(join(tmpdir(), 'kata-release-required-'));
        await mkdir(join(root, '.kata/wiki'), { recursive: true });

        const result = await checkReleaseGates(root, {
            acceptancePassRate: 0.95, repairRate: 0.2, escalationRate: null,
            avgCostPerTask: null, avgLatencyMs: 500, wikiRejectionRate: 0,
            totalTasks: 10, totalAcceptances: 20, totalPassed: 19, totalFailed: 1,
            totalRepairs: 2, totalEscalations: null, totalTokens: null, totalCost: null,
            totalLatencyMs: 5000, totalWikiRejected: 0, totalWikiPromoted: 5,
            metricCoverage: { tokens: 0, cost: 0, escalations: 0 },
        } as never);

        const seeds = result.gates.find((gate) => gate.name === 'mechanism-seeds');
        expect(seeds, 'the computed quality gate must be present').toBeDefined();
        expect(seeds?.pass).toBe(true);
        expect(seeds?.details).toContain('seeds matched');
        expect(seeds?.details, 'and it says how much of the vocabulary was exercised').toContain('refusal reason(s) exercised');

        // The seed gate is required: a release is not ready while the mechanism's own seeds disagree with it.
        expect(result.unmeasuredRequiredGates.map((gate) => gate.name)).not.toContain('mechanism-seeds');

        // And the recall gate is not, with the reason on it rather than in a comment.
        const recall = result.gates.find((gate) => gate.name === 'verifier-critical-recall');
        expect(recall?.skipped).toBe(true);
        expect(recall?.details).toContain('Informational: not required for a release');
        expect(result.unmeasuredRequiredGates.map((gate) => gate.name)).not.toContain('verifier-critical-recall');
    });

  it('passes when all gates meet thresholds', async () => {
    const metrics = {
      acceptancePassRate: 0.95, repairRate: 0.2, escalationRate: 0.1,
      avgCostPerTask: 0.01, avgLatencyMs: 500, wikiRejectionRate: 0,
      totalTasks: 10, totalAcceptances: 20, totalPassed: 19, totalFailed: 1,
      totalRepairs: 2, totalEscalations: 1, totalTokens: 1000, totalCost: 0.1,
      totalLatencyMs: 5000, totalWikiRejected: 0, totalWikiPromoted: 5,
      metricCoverage: { tokens: 10, cost: 10, escalations: 10 },
    };

    const { writeFile, mkdir, mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'kata-release-'));
    await mkdir(join(root, '.kata/wiki'), { recursive: true });
    await writeFile(join(root, '.kata/wiki/test-record.json'), JSON.stringify({ id: 'test', status: 'verified', statement: 'test', scope: ['test'], kind: 'test', sourceRefs: ['test.ts'], sourceHashes: {}, validationTaskId: 'task', evidenceIds: ['e1'], lastVerifiedAt: '2026-01-01', createdAt: '2026-01-01', updatedAt: '2026-01-01' }), 'utf8');

    const result = await checkReleaseGates(root, metrics);
    expect(result.allPass).toBe(true);
  });

  it('fails when acceptance pass rate is below threshold', async () => {
    const metrics = {
      acceptancePassRate: 0.5, repairRate: 0, escalationRate: 0,
      avgCostPerTask: 0, avgLatencyMs: 0, wikiRejectionRate: 0,
      totalTasks: 2, totalAcceptances: 4, totalPassed: 2, totalFailed: 2,
      totalRepairs: 0, totalEscalations: 0, totalTokens: 0, totalCost: 0,
      totalLatencyMs: 0, totalWikiRejected: 0, totalWikiPromoted: 0,
      metricCoverage: { tokens: 0, cost: 0, escalations: 0 },
    };

    const { mkdir, mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'kata-release-fail-'));
    await mkdir(join(root, '.kata/wiki'), { recursive: true });

    const result = await checkReleaseGates(root, metrics, { minAcceptancePassRate: 0.8 });
    expect(result.allPass).toBe(false);
    expect(result.gates.find((g) => g.name === 'acceptance-pass-rate')?.pass).toBe(false);
  });

  it('skips a gate whose metric was never measured instead of passing it on a fabricated zero', async () => {
    const metrics = {
      acceptancePassRate: 1, repairRate: 0, escalationRate: null,
      avgCostPerTask: null, avgLatencyMs: 10, wikiRejectionRate: 0,
      totalTasks: 1, totalAcceptances: 1, totalPassed: 1, totalFailed: 0,
      totalRepairs: 0, totalEscalations: null, totalTokens: null, totalCost: null,
      totalLatencyMs: 10, totalWikiRejected: 0, totalWikiPromoted: 0,
      metricCoverage: { tokens: 0, cost: 0, escalations: 0 },
    };

    const { mkdir, mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = await mkdtemp(join(tmpdir(), 'kata-release-skip-'));
    await mkdir(join(root, '.kata/wiki'), { recursive: true });

    const result = await checkReleaseGates(root, metrics);

    expect(result.gates.find((g) => g.name === 'escalation-rate')).toMatchObject({ skipped: true });
    expect(result.allPass).toBe(true);
    expect(result.summary).toMatch(/skipped as unmeasured/);
  });
});

describe('Release gates: the verifier budget is judged against measured recall, not against cost', () => {
  const metrics = {
    totalTasks: 1,
    totalAcceptances: 1,
    totalPassed: 1,
    acceptancePassRate: 1,
    repairRate: 0,
    totalRepairs: 0,
    escalationRate: 0,
    avgLatencyMs: 10,
    avgTokens: 10,
    wikiPromoted: 0,
    wikiRejected: 0,
    wikiRejectionRate: 0,
    metricCoverage: {},
  } as never;

  it('refuses an optimization that improved cost while lowering critical recall', async () => {
    // AC-5: the objective is minimize(tokens, latency) *subject to* criticalRecall >= baseline. A cheaper verifier is
    // not an improvement if it misses defects, and the miss is invisible without this comparison.
    const { admissibilityCorpus, scoreCorpus } = await import('../../src/eval/admissibility-corpus.js');
    const corpus = admissibilityCorpus();
    const critical = corpus.filter((entry) => entry.critical === true);
    const { join } = await import('node:path');
    const { mkdtemp, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const root = await mkdtemp(join(tmpdir(), 'kata-corpus-gate-'));
    await mkdir(join(root, '.kata/wiki'), { recursive: true });

    // The verifier missed one critical defect that the baseline caught — a cost win that must lose here.
    const current = scoreCorpus(corpus, critical.map((entry, index) => ({
      caseId: entry.id,
      verdict: index === 0 ? 'no_defect_found' : 'defects_found',
      findingIds: index === 0 ? [] : entry.expectedFindings,
    })));
    const baseline = scoreCorpus(corpus, critical.map((entry) => ({
      caseId: entry.id,
      verdict: 'defects_found',
      findingIds: entry.expectedFindings,
    })));

    const result = await checkReleaseGates(root, metrics, { verifierBaseline: baseline, verifierCurrent: current });
    const gate = result.gates.find((entry) => entry.name === 'verifier-critical-recall');
    expect(gate).toMatchObject({ pass: false });
    expect(gate?.details).toMatch(/recall/i);
    expect(result.allPass).toBe(false);
  });

  it('passes a verifier that holds recall and false-pass rate at the baseline', async () => {
    // The other direction: the gate must not merely always refuse, or it proves nothing about the change it guards.
    const { admissibilityCorpus, scoreCorpus } = await import('../../src/eval/admissibility-corpus.js');
    const corpus = admissibilityCorpus();
    const clean = corpus.map((entry) => ({
      caseId: entry.id,
      verdict: entry.expectedVerdict,
      findingIds: entry.expectedFindings,
    }));
    const score = scoreCorpus(corpus, clean);
    const { join } = await import('node:path');
    const { mkdtemp, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const root = await mkdtemp(join(tmpdir(), 'kata-corpus-gate-ok-'));
    await mkdir(join(root, '.kata/wiki'), { recursive: true });

    const result = await checkReleaseGates(root, metrics, { verifierBaseline: score, verifierCurrent: score });
    expect(result.gates.find((entry) => entry.name === 'verifier-critical-recall')).toMatchObject({ pass: true });
  });

  it('reports the gate as skipped rather than passed when no verifier was measured', async () => {
    // Same rule as every other gate here: green because nothing was checked is the failure mode this exists to remove.
    const { join } = await import('node:path');
    const { mkdtemp, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const root = await mkdtemp(join(tmpdir(), 'kata-corpus-gate-skip-'));
    await mkdir(join(root, '.kata/wiki'), { recursive: true });

    const result = await checkReleaseGates(root, metrics);
    expect(result.gates.find((entry) => entry.name === 'verifier-critical-recall')).toMatchObject({ skipped: true });
  });
});

describe('Evaluation runner', () => {
  it('produces a report from a manifest', async () => {
    const manifest: EvaluationManifest = {
      taskFixtures: [
        { id: 'open', description: 'Open task', expectedAcceptances: 2, expectedRepairs: 0, expectedEscalations: 0 },
        { id: 'verify', description: 'Verify task', expectedAcceptances: 2, expectedRepairs: 0, expectedEscalations: 0 },
      ],
    };

    const { mkdtemp } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const root = await mkdtemp(join(tmpdir(), 'kata-eval-run-'));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, '.kata/wiki'), { recursive: true });

    const report = await runEvaluation(manifest, root);
    expect(report.runs).toHaveLength(2);
    expect(report.metrics.totalTasks).toBe(2);
    expect(report.releaseGates.allPass).toBe(true);
    expect(report.timestamp).toBeTruthy();
  });
});

/**
 * AC-5 is the corpus's own acceptance criterion: it must *gate* optimization, and a corpus that does not cover the
 * criterion about gating cannot referee itself. Measured before this: the cases covered AC-1/2/3/4/6 and left AC-5 out,
 * so "the corpus gates every optimization" was the one claim no case tested.
 */
describe('the corpus covers the criterion that makes it a gate', () => {
    /** The rule the seal applies: one selector, one criterion, because the seal emits one evidence file per selector. */
    function criteriaSharingASelector(rows: Array<{ acceptanceId: string; evidence?: Array<{ id?: string; kind?: string; testSelector?: string }> }>): string[] {
        const bySelector = new Map<string, string[]>();
        for (const row of rows) {
            for (const item of row.evidence ?? []) {
                const selector = item.testSelector ?? `${row.acceptanceId}:${item.id ?? item.kind}`;
                bySelector.set(selector, [...(bySelector.get(selector) ?? []), row.acceptanceId]);
            }
        }
        return [...bySelector.entries()]
            .filter(([, ids]) => new Set(ids).size > 1)
            .map(([selector, ids]) => `${selector} declared by ${[...new Set(ids)].join(', ')}`);
    }

    it('refuses two criteria sharing one selector, and accepts a matrix where each has its own', () => {
        // **The fixture is constructed, because a fixture borrowed from the repository measures the repository.**
        //
        // This case has now had both of its shapes fail for the same reason. The first version read an absolute path
        // inside a leftover linked worktree, so it passed only while that stale checkout existed. The second read the real
        // task record from `process.cwd()` — which is this workspace when the suite runs on its own, and the seal's
        // *isolated snapshot* when it runs inside a seal. `.kata/` is gitignored, so the snapshot does not carry it, and
        // the case failed only where it mattered: measured, `npm test` exit 1 inside the seal while the same suite was
        // green outside it.
        //
        // What the criterion is about is the rule, so the rule is what is tested — and testing it this way makes the case
        // able to fail, which the previous two versions could not: they could only notice that a record was missing.
        const shared = criteriaSharingASelector([
            { acceptanceId: 'AC-1', evidence: [{ id: 'e-1', kind: 'test', testSelector: 'tests/unit/a.test.ts' }] },
            { acceptanceId: 'AC-2', evidence: [{ id: 'e-2', kind: 'test', testSelector: 'tests/unit/a.test.ts' }] },
        ]);
        expect(shared, 'two criteria naming one selector cannot both be evidenced by it').toEqual(['tests/unit/a.test.ts declared by AC-1, AC-2']);

        const distinct = criteriaSharingASelector([
            { acceptanceId: 'AC-1', evidence: [{ id: 'e-1', kind: 'test', testSelector: 'tests/unit/a.test.ts' }] },
            { acceptanceId: 'AC-2', evidence: [{ id: 'e-2', kind: 'test', testSelector: 'tests/unit/b.test.ts' }] },
        ]);
        expect(distinct).toEqual([]);

        // And a declaration with no selector is keyed by its own identity, so two criteria using the same *command* shape
        // are still distinguished — the failure mode the `?? fallback` exists for.
        const unselector = criteriaSharingASelector([
            { acceptanceId: 'AC-1', evidence: [{ id: 'e-1', kind: 'entrypoint' }] },
            { acceptanceId: 'AC-2', evidence: [{ id: 'e-1', kind: 'entrypoint' }] },
        ]);
        expect(unselector).toEqual([]);
    });

    it('scores the retired corpus through the surface that has no repository dependency', async () => {
        // The corpus's own coverage, asserted where it can be asserted: `ledger corpus` builds every seed in memory and
        // needs no workspace, which is why it is the instrument that works inside a seal.
        const { scoreSeeds } = await import('../../src/store/corpus.js');
        const score = await scoreSeeds();
        expect(score.mismatched, 'every seed must decide as its own expectation declares').toEqual([]);
        expect(score.reasonsUnexercised, 'a refusal reason no seed exercises is a rule with no example').toEqual([]);
    });
});

/**
 * P1.2 — the shadow comparison, published.
 *
 * Phase 4's acceptance is that every disagreement sample is visible and that the comparison is published rather than
 * computed and discarded. The two rules differ in one place: the legacy rule took a declared verdict as an answer, so
 * `no_defect_found` on a revision carrying a critical defect read as a pass.
 */
describe('the legacy rule and the derived rule are compared case by case', () => {
    it('covers every corpus case, and publishes each disagreement with its case id', async () => {
        const { admissibilityCorpus, shadowCorpusReport } = await import('../../src/eval/admissibility-corpus.js');
        const corpus = admissibilityCorpus();

        // A verifier that answers "nothing wrong" everywhere: the exact shape the legacy rule passed and the derived
        // rule refuses on critical cases.
        const observations = corpus.map((entry) => ({ caseId: entry.id, verdict: 'no_defect_found' as const, findingIds: [] }));
        const report = shadowCorpusReport(corpus, observations);

        // 1. Every case appears — the comparison covers the same entries for both paths.
        expect(report.map((row) => row.caseId).sort()).toEqual(corpus.map((entry) => entry.id).sort());

        // 2. A legacy acceptance the derived rule refuses is a **disagreement with its case id**, not a count.
        const disagreements = report.filter((row) => !row.agrees);
        expect(disagreements.length).toBeGreaterThan(0);
        const criticalFalsePass = disagreements.find((row) => row.critical && row.derivedVerdict === 'false_pass');
        expect(criticalFalsePass).toBeDefined();
        expect(criticalFalsePass!.legacyAccepted).toBe(true);
        expect(criticalFalsePass!.disagreement).toContain('false_pass');
        expect(criticalFalsePass!.caseId).toBe(corpus.find((entry) => entry.id === criticalFalsePass!.caseId)!.id);
    });

    it('reads an empty comparison as nothing compared, never as no disagreements', async () => {
        const { admissibilityCorpus, shadowCorpusReport } = await import('../../src/eval/admissibility-corpus.js');
        const root = await mkdtemp(join(tmpdir(), 'kata-shadow-empty-'));
        try {
            await initLayout(root);
            // Every case still appears, and none of them claims to have been compared.
            const noneObserved = shadowCorpusReport(admissibilityCorpus(), []);
            expect(noneObserved.length).toBe(admissibilityCorpus().length);
            expect(noneObserved.every((row) => !row.compared && !row.agrees)).toBe(true);

            const report = await runEvaluation(
                { taskFixtures: [], verifier: { baseline: [], current: [] } } as never,
                root,
            );
            // An empty comparison must not be readable as a clean one. Every case still appears — the comparison covers
            // the same entries for both paths — but **no row claims agreement**, and the marker says why.
            expect(report.verifierShadowNote).toMatch(/nothing compared/);
            expect(report.verifierShadow?.length).toBe(admissibilityCorpus().length);
            expect(report.verifierShadow?.every((row) => !row.compared && !row.agrees)).toBe(true);
            expect(report.verifierShadow?.every((row) => row.disagreement === 'not observed: nothing was compared for this case')).toBe(true);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    }, 30000);

    it('publishes the comparison through the report, not only through the function', async () => {
        const { admissibilityCorpus } = await import('../../src/eval/admissibility-corpus.js');
        const root = await mkdtemp(join(tmpdir(), 'kata-shadow-published-'));
        try {
            await initLayout(root);
            const corpus = admissibilityCorpus();
            const observations = corpus.map((entry) => ({ caseId: entry.id, verdict: 'no_defect_found' as const, findingIds: [] }));
            const report = await runEvaluation({ taskFixtures: [], verifier: { baseline: observations, current: observations } } as never, root);

            expect(report.verifierShadow?.length).toBe(corpus.length);
            expect(report.verifierShadow?.some((row) => !row.agrees)).toBe(true);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    }, 30000);
});

/**
 * f3 of the independent pass's findings: AC-5 quantifies over the **whole corpus**, and the declared selector pinned one
 * case by id.
 *
 * The changelog records that a general rule was written first, failed on two `guard-false-negative` cases, and was replaced
 * by the single-case assertion. So the rule has to be one that is *true of every case*, and the reason the first attempt
 * failed is worth stating: those cases' reproductions describe the **harm** (a guard refusing an honest report) while their
 * expected verdict is the honest conclusion. "The reproduction's wording matches the verdict" cannot hold — the
 * reproduction says how to reconstruct the revision, the verdict says what a correct verifier must reach.
 *
 * What does hold for every case is the coherence between the two things a case declares about a correct verifier: the
 * verdict it must reach and the findings it must name. A verdict of `defects_found` with nothing named, or
 * `no_defect_found` while naming defects, is a case no verifier could satisfy — and every optimisation is scored against
 * these, so a self-contradictory case would make the referee wrong rather than the change.
 */
describe('AC-5 over the whole corpus, not one case', () => {
    it('holds for every case that a verdict and the findings it names cannot contradict each other', async () => {
        const { admissibilityCorpus } = await import('../../src/eval/admissibility-corpus.js');
        const cases = admissibilityCorpus();
        expect(cases.length).toBeGreaterThan(0);

        const offenders: string[] = [];
        for (const entry of cases) {
            const findings = entry.expectedFindings ?? [];
            if (entry.expectedVerdict === 'defects_found' && findings.length === 0) {
                offenders.push(`${entry.id}: defects_found while naming no finding`);
            }
            if (entry.expectedVerdict === 'no_defect_found' && findings.length > 0) {
                offenders.push(`${entry.id}: no_defect_found while naming ${findings.length} finding(s)`);
            }
            if (new Set(findings).size !== findings.length) {
                offenders.push(`${entry.id}: the same finding id is named twice`);
            }
        }
        expect(offenders).toEqual([]);

        // Not a blanket pass: the rule has to be exercised in both directions, or it would hold on an empty corpus too.
        expect(cases.some((entry) => entry.expectedVerdict === 'defects_found')).toBe(true);
        expect(cases.some((entry) => entry.expectedVerdict === 'no_defect_found')).toBe(true);
        // And the class the first rule failed on is present, so a future edit to those cases is covered too.
        expect(cases.some((entry) => entry.kinds.includes('guard-false-negative'))).toBe(true);
    });
});
