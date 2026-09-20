export interface EvaluationRun {
  id: string;
  taskId: string;
  acceptances: number;
  acceptancesPassed: number;
  acceptancesFailed: number;
  repairCount: number;
  /**
   * `null` when this harness cannot observe it.
   *
   * The host platform owns model choice, cost and retries, so a number here would be invented. A `0` used to be
   * written instead, which a reader could mistake for a measured zero — the exact failure the `unmeasured` list
   * exists to prevent. `null` says "not observed" and cannot be summed by accident.
   */
  escalationCount: number | null;
  tokensUsed: number | null;
  costCredits: number | null;
  latencyMs: number;
  wikiRejected: number;
  wikiPromoted: number;
}

export interface EvaluationMetrics {
  acceptancePassRate: number;
  repairRate: number;
  /** `null` when no run carried an escalation count. */
  escalationRate: number | null;
  /** `null` when no run carried a cost. */
  avgCostPerTask: number | null;
  avgLatencyMs: number;
  wikiRejectionRate: number;
  totalTasks: number;
  totalAcceptances: number;
  totalPassed: number;
  totalFailed: number;
  totalRepairs: number;
  totalEscalations: number | null;
  totalTokens: number | null;
  totalCost: number | null;
  totalLatencyMs: number;
  totalWikiRejected: number;
  totalWikiPromoted: number;
  /**
   * How many runs actually carried a value for each unmeasurable metric.
   *
   * Zero coverage with a `null` aggregate is the honest report. Without it a reader cannot tell "nothing cost
   * anything" from "nobody looked", so every cost figure is published with the size of the sample behind it.
   */
  metricCoverage: { tokens: number; cost: number; escalations: number };
}

/** Sums the values that exist; `null` when none do. An unmeasured metric is never reported as 0. */
function sumMeasured(values: Array<number | null>): number | null {
  let total = 0;
  let measured = 0;
  for (const value of values) {
    if (value === null) continue;
    total += value;
    measured += 1;
  }
  return measured > 0 ? total : null;
}

function perTaskOrNull(total: number | null, tasks: number): number | null {
  return total === null || tasks === 0 ? null : total / tasks;
}

export function computeMetrics(runs: EvaluationRun[]): EvaluationMetrics {
  const tasks = runs.length;
  const acceptances = runs.reduce((sum, run) => sum + run.acceptances, 0);
  const passed = runs.reduce((sum, run) => sum + run.acceptancesPassed, 0);
  const failed = runs.reduce((sum, run) => sum + run.acceptancesFailed, 0);
  const repairs = runs.reduce((sum, run) => sum + run.repairCount, 0);
  const latency = runs.reduce((sum, run) => sum + run.latencyMs, 0);
  const wikiRejected = runs.reduce((sum, run) => sum + run.wikiRejected, 0);
  const wikiPromoted = runs.reduce((sum, run) => sum + run.wikiPromoted, 0);

  const escalations = sumMeasured(runs.map((run) => run.escalationCount));
  const tokens = sumMeasured(runs.map((run) => run.tokensUsed));
  const cost = sumMeasured(runs.map((run) => run.costCredits));

  return {
    acceptancePassRate: acceptances > 0 ? passed / acceptances : 0,
    repairRate: tasks > 0 ? repairs / tasks : 0,
    escalationRate: perTaskOrNull(escalations, tasks),
    avgCostPerTask: perTaskOrNull(cost, tasks),
    avgLatencyMs: tasks > 0 ? latency / tasks : 0,
    wikiRejectionRate: wikiPromoted + wikiRejected > 0 ? wikiRejected / (wikiPromoted + wikiRejected) : 0,
    totalTasks: tasks,
    totalAcceptances: acceptances,
    totalPassed: passed,
    totalFailed: failed,
    totalRepairs: repairs,
    totalEscalations: escalations,
    totalTokens: tokens,
    totalCost: cost,
    totalLatencyMs: latency,
    totalWikiRejected: wikiRejected,
    totalWikiPromoted: wikiPromoted,
    metricCoverage: {
      tokens: runs.filter((run) => run.tokensUsed !== null).length,
      cost: runs.filter((run) => run.costCredits !== null).length,
      escalations: runs.filter((run) => run.escalationCount !== null).length,
    },
  };
}
