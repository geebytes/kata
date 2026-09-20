import { readWikiRecords } from '../wiki/store.js';
import { type EvaluationMetrics } from './metrics.js';

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

  // A skipped gate is neither a pass nor a failure: it is the report saying it does not know.
  const scored = gates.filter((gate) => gate.skipped !== true);
  const allPass = scored.every((gate) => gate.pass);
  const passed = scored.filter((gate) => gate.pass).length;
  const skipped = gates.length - scored.length;

  return {
    gates,
    allPass,
    summary: allPass
      ? `All ${scored.length} scored release gates passed${skipped > 0 ? `; ${skipped} skipped as unmeasured` : ''}.`
      : `${passed}/${scored.length} scored release gates passed. Review failed gates before release${skipped > 0 ? ` (${skipped} skipped as unmeasured)` : ''}.`,
  };
}
