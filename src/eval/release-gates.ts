import { readWikiRecords } from '../wiki/store.js';
import { type EvaluationMetrics } from './metrics.js';

export interface ReleaseGate {
  name: string;
  description: string;
  pass: boolean;
  details: string;
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

  const escalationGate: ReleaseGate = {
    name: 'escalation-rate',
    description: `Average escalations per task <= ${opts.maxEscalationRate}`,
    pass: metrics.escalationRate <= opts.maxEscalationRate,
    details: `Escalation rate: ${metrics.escalationRate.toFixed(2)} per task (${metrics.totalEscalations} escalations / ${metrics.totalTasks} tasks)`,
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

  const allPass = gates.every((g) => g.pass);
  const passed = gates.filter((g) => g.pass).length;

  return {
    gates,
    allPass,
    summary: allPass
      ? `All ${gates.length} release gates passed.`
      : `${passed}/${gates.length} release gates passed. Review failed gates before release.`,
  };
}
