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
export declare function checkReleaseGates(root: string, metrics: EvaluationMetrics, options?: {
    minAcceptancePassRate?: number;
    maxRepairRate?: number;
    maxEscalationRate?: number;
    minWikiCount?: number;
    maxWikiRejectionRate?: number;
}): Promise<ReleaseGateResult>;
//# sourceMappingURL=release-gates.d.ts.map