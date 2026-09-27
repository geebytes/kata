import { readWikiRecords } from '../wiki/store.js';
import { type EvaluationMetrics } from './metrics.js';
import { type CorpusScore } from './admissibility-corpus.js';

export interface ReleaseGate {
  name: string;
  description: string;
  pass: boolean;
  details: string;
  /**
   * True when the metric behind this gate was not observed at all.
   *
   * A gate cannot pass on evidence it does not have, and it must not fail on a limitation of the harness either —
   * the third state is the honest one. `allPass` ignores skipped gates; the gate itself is still reported so
   * nobody reads "all gates passed" as "cost was measured".
   */
  skipped?: boolean;
}

export interface ReleaseGateResult {
  gates: ReleaseGate[];
  allPass: boolean;
  /**
   * Whether a release may proceed — **the field a release decision should read.**
   *
   * `allPass` answers "of the gates that were scored, did they all pass", which is a different question: a required gate
   * that never received its input is reported `skipped` and excluded from `allPass`, so a release could read `allPass:
   * true` while the critical-recall comparison had never been made. `releaseReady` is false whenever a **required** gate
   * is skipped, and names them, so "nobody measured this" cannot be mistaken for "this was measured and passed".
   */
  releaseReady: boolean;
  /** The required gates that were skipped, with the reason each gave. Empty when nothing required was skipped. */
  unmeasuredRequiredGates: Array<{ name: string; details: string }>;
  summary: string;
}

export async function checkReleaseGates(
  root: string,
  metrics: EvaluationMetrics,
  options: {
    minAcceptancePassRate?: number;
    maxRepairRate?: number;
    maxEscalationRate?: number;
    minWikiCount?: number;
    maxWikiRejectionRate?: number;
    /**
     * Per-fixture expectation verdicts, when the caller actually ran fixtures.
     *
     * Absent means "nothing was evaluated" and is reported as a skipped gate, never as a pass: a release gate that
     * goes green because it was never given anything to check is the failure mode this gate exists to remove.
     */
    expectations?: Array<{ id: string; matched: boolean; mismatches: string[] }>;
    /**
     * The concurrency the fixtures were evaluated at, when the caller ran them.
     *
     * Recorded rather than inferred: resource-related fixture failures are the reason the default is serial, so a report
     * that shows a parallel run must say so where the reader is already looking for what happened.
     */
    concurrency?: number;
    /**
     * The verifier scored against the admissibility corpus, before and after the change (AC-5).
     *
     * Absent means nothing was scored, and the gate reports `skipped` rather than passing: the point of the comparison
     * is that a cost win may not be certified from cost alone.
     */
    verifierBaseline?: CorpusScore;
    verifierCurrent?: CorpusScore;
    /**
     * Declared verifier observations the corpus does not know (R6).
     *
     * A manifest naming a case id no corpus entry carries has measured nothing, so the gate fails and says which side was
     * refused rather than scoring a zero denominator as a held line.
     */
    verifierObservationProblems?: string[];
  } = {},
): Promise<ReleaseGateResult> {
  const opts = {
    minAcceptancePassRate: options.minAcceptancePassRate ?? 0.8,
    maxRepairRate: options.maxRepairRate ?? 1.0,
    maxEscalationRate: options.maxEscalationRate ?? 0.5,
    minWikiCount: options.minWikiCount ?? 0,
    maxWikiRejectionRate: options.maxWikiRejectionRate ?? 0.5,
  };

  const gates: ReleaseGate[] = [];

  const acceptanceGate: ReleaseGate = {
    name: 'acceptance-pass-rate',
    description: `Acceptance pass rate >= ${(opts.minAcceptancePassRate * 100).toFixed(0)}%`,
    pass: metrics.acceptancePassRate >= opts.minAcceptancePassRate,
    details: `Pass rate: ${(metrics.acceptancePassRate * 100).toFixed(1)}% (${metrics.totalPassed}/${metrics.totalAcceptances})`,
  };
  gates.push(acceptanceGate);

  const repairGate: ReleaseGate = {
    name: 'repair-rate',
    description: `Average repairs per task <= ${opts.maxRepairRate}`,
    pass: metrics.repairRate <= opts.maxRepairRate,
    details: `Repair rate: ${metrics.repairRate.toFixed(2)} per task (${metrics.totalRepairs} repairs / ${metrics.totalTasks} tasks)`,
  };
  gates.push(repairGate);

  const expectations = options.expectations;
  const mismatched = (expectations ?? []).filter((entry) => !entry.matched);
  const expectationGate: ReleaseGate = expectations === undefined
    ? {
        name: 'fixture-expectations',
        description: 'Every fixture produced what its manifest declared',
        pass: true,
        skipped: true,
        details: 'No fixtures were evaluated, so no expectation was checked.',
      }
    : {
        name: 'fixture-expectations',
        description: 'Every fixture produced what its manifest declared',
        pass: mismatched.length === 0,
        details: mismatched.length === 0
          ? `${expectations.length}/${expectations.length} fixtures matched their declared expectation.`
          : `${mismatched.length}/${expectations.length} fixtures did not match: ${mismatched.map((entry) => `${entry.id} (${entry.mismatches.join('; ')})`).join(' | ')}`,
      };
  // The note has to reach a report, or the phase records nothing: attach it to the gate whose failure mode it explains.
  // A fixture that failed only under concurrency is exactly the case the note is for, and `details` is what the human
  // report prints — computing it into a local nothing reads would leave the concurrency recorded nowhere.
  const parallelismNote = options.concurrency !== undefined && options.concurrency > 1
    ? ` Evaluated with concurrency ${options.concurrency}; a resource-related failure may be an artefact of that, not of the change.`
    : '';
  expectationGate.details += parallelismNote;
  gates.push(expectationGate);

  const escalationGate: ReleaseGate = metrics.escalationRate === null
    ? {
        name: 'escalation-rate',
        description: `Average escalations per task <= ${opts.maxEscalationRate}`,
        pass: true,
        skipped: true,
        details: `Not measured by this harness (${metrics.metricCoverage.escalations}/${metrics.totalTasks} runs carried a value); the gate is skipped rather than passed on a fabricated zero.`,
      }
    : {
        name: 'escalation-rate',
        description: `Average escalations per task <= ${opts.maxEscalationRate}`,
        pass: metrics.escalationRate <= opts.maxEscalationRate,
        details: `Escalation rate: ${metrics.escalationRate.toFixed(2)} per task (${metrics.totalEscalations} escalations / ${metrics.totalTasks} tasks, ${metrics.metricCoverage.escalations} measured)`,
      };
  gates.push(escalationGate);

  const wikiCount = (await readWikiRecords(root)).length;
  const wikiCountGate: ReleaseGate = {
    name: 'wiki-governance',
    description: `Wiki contains >= ${opts.minWikiCount} records`,
    pass: wikiCount >= opts.minWikiCount,
    details: `Wiki records: ${wikiCount}`,
  };
  gates.push(wikiCountGate);

  const wikiRejectionGate: ReleaseGate = {
    name: 'wiki-rejection-rate',
    description: `Wiki rejection rate <= ${(opts.maxWikiRejectionRate * 100).toFixed(0)}%`,
    pass: metrics.wikiRejectionRate <= opts.maxWikiRejectionRate,
    details: `Wiki rejection rate: ${(metrics.wikiRejectionRate * 100).toFixed(1)}%`,
  };
  gates.push(wikiRejectionGate);

  // AC-5: the optimization's acceptance condition. Cost is only allowed to fall while critical recall holds, so the
  // comparison is a gate rather than a number in a report — a cheaper verifier that misses defects is the one failure
  // mode that stays invisible without it.
  const baseline = options.verifierBaseline;
  const current = options.verifierCurrent;
  // R6: a manifest that declares verifier observations naming no corpus case has not measured anything, and must not be
  // reported as having held the line. Fail-closed and named, before the comparison below can pass on 0 >= 0.
  const refused = options.verifierObservationProblems;
  const recallGate: ReleaseGate = refused && refused.length > 0
    ? {
        name: 'verifier-critical-recall',
        description: 'Critical defect recall >= baseline, and false-pass rate <= baseline',
        pass: false,
        details: `The declared verifier observations do not name corpus cases, so nothing was measured and the comparison cannot be made: ${refused.join('; ')}. Scoring them anyway reported a zero denominator as a held line (0 >= 0).`,
      }
    : baseline === undefined || current === undefined
    ? {
        name: 'verifier-critical-recall',
        description: 'Critical defect recall >= baseline, and false-pass rate <= baseline',
        pass: true,
        skipped: true,
        details: 'No verifier was scored against the admissibility corpus, so recall was not measured; the gate is skipped rather than passed on an assumption. Informational: not required for a release — see `mechanism-seeds` for the quality gate that is computed.',
      }
    : {
        name: 'verifier-critical-recall',
        description: 'Critical defect recall >= baseline, and false-pass rate <= baseline',
        pass: current.criticalRecall >= baseline.criticalRecall && current.falsePassRate <= baseline.falsePassRate,
        details: `DECLARED, NOT RUN — both sides come from the manifest, because the runner has no verifier to execute. `
          + `Critical recall ${(current.criticalRecall * 100).toFixed(1)}% vs baseline ${(baseline.criticalRecall * 100).toFixed(1)}%; `
          + `false-pass ${(current.falsePassRate * 100).toFixed(1)}% vs baseline ${(baseline.falsePassRate * 100).toFixed(1)}% (${current.cases} corpus cases). `
          + 'Informational: this gate is not required for a release, because a comparison whose two sides an author writes cannot hold a line.'
          + (current.criticalRecall < baseline.criticalRecall
            ? ' Recall fell: a cheaper verifier that misses defects is not an optimization.'
            : current.falsePassRate > baseline.falsePassRate ? ' The false-pass rate rose above the baseline.' : ''),
      };
  gates.push(recallGate);

  /**
   * The mechanism's own seed corpus, decided and compared — **the gate that replaced one that could not be measured.**
   *
   * `ledger corpus` scores every seed the mechanism ships against the verdict it declares, with no model, no round and no
   * host: a mismatch is a defect in the kernel or a wrong expectation, and both sides are printed. It is the check that
   * can fail (26 seeds today, every refusal reason exercised), which is what makes it usable as a required gate where
   * `verifier-critical-recall` — whose two sides are both declared in a manifest — is not.
   */
  let seedGate: ReleaseGate;
  try {
    const { scoreSeeds } = await import('../store/corpus.js');
    const seeds = await scoreSeeds();
    seedGate = {
      name: 'mechanism-seeds',
      description: 'Every seed the review mechanism ships decides as its own expectation declares',
      pass: seeds.mismatched.length === 0 && seeds.reasonsUnexercised.length === 0,
      details: `${seeds.matched}/${seeds.cases} seeds matched (${Object.entries(seeds.byVerdict).map(([verdict, count]) => `${verdict} ${count}`).join(', ')}); `
        + `${seeds.reasonsExercised.length} refusal reason(s) exercised, ${seeds.reasonsUnexercised.length} never exercised`
        + (seeds.mismatched.length > 0 ? `; mismatched: ${seeds.mismatched.map((entry) => entry.id).join(', ')}` : '')
        + (seeds.reasonsUnexercised.length > 0 ? `; never exercised: ${seeds.reasonsUnexercised.join(', ')}` : ''),
    };
  } catch (error) {
    // Fails closed: a seed corpus that cannot be scored has measured nothing, and "could not run" is not a pass.
    seedGate = {
      name: 'mechanism-seeds',
      description: 'Every seed the review mechanism ships decides as its own expectation declares',
      pass: false,
      details: `the seed corpus could not be scored: ${(error as Error).message}`,
    };
  }
  gates.push(seedGate);

  // A skipped gate is neither a pass nor a failure: it is the report saying it does not know.
  const scored = gates.filter((gate) => gate.skipped !== true);
  const allPass = scored.every((gate) => gate.pass);
  const passed = scored.filter((gate) => gate.pass).length;
  const skipped = gates.length - scored.length;
  // **A required gate that was never measured is not a passing release.** `allPass` excludes skipped gates by design, so
  // on its own it can read `true` while the quality comparison that matters most was never made. The quality gates are
  // required; cost and escalation-rate gates are informational because their inputs are not always available (a run with
  // no fixtures has no escalation rate to report).
  // **Which gates are required is a decision about what can be measured.** `verifier-critical-recall` compares two
  // *declared* observation sets — the runner has no verifier to run, so both sides come from the manifest — and the
  // baseline it should compare against is the retired mechanism's recall on this corpus, which no longer exists. A gate
  // whose input is author-declared and whose baseline is unobtainable cannot be required, so it is informational and says
  // so in its details. What replaces it is `mechanism-seeds`, which is computed: the kernel's own decision over every seed
  // the mechanism ships, with no hand-declared answers anywhere in the path.
  const qualityGates = new Set(['mechanism-seeds', 'acceptance-pass-rate', 'wiki-rejection-rate']);
  const unmeasuredRequiredGates = gates
    .filter((gate) => gate.skipped === true && qualityGates.has(gate.name))
    .map((gate) => ({ name: gate.name, details: gate.details }));
  const releaseReady = allPass && unmeasuredRequiredGates.length === 0;

  const skippedNote = skipped > 0 ? `; ${skipped} skipped as unmeasured` : '';
  const requiredNote = unmeasuredRequiredGates.length > 0
    ? ` Not release-ready: ${unmeasuredRequiredGates.map((gate) => gate.name).join(', ')} produced no measurement.`
    : '';
  return {
    gates,
    allPass,
    releaseReady,
    unmeasuredRequiredGates,
    summary: `${allPass
      ? `All ${scored.length} scored release gates passed${skippedNote}.`
      : `${passed}/${scored.length} scored release gates passed. Review failed gates before release${skippedNote}.`}${requiredNote}`,
  };
}
