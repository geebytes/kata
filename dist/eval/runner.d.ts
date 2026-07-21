import { type EvaluationRun, type EvaluationMetrics } from './metrics.js';
import { type ReleaseGateResult } from './release-gates.js';
export interface EvaluationManifest {
    taskFixtures: Array<{
        id: string;
        description: string;
        expectedAcceptances: number;
        expectedRepairs: number;
        expectedEscalations: number;
    }>;
}
export interface EvaluationReport {
    manifest: EvaluationManifest;
    runs: EvaluationRun[];
    metrics: EvaluationMetrics;
    releaseGates: ReleaseGateResult;
    timestamp: string;
    durationMs: number;
}
export declare function runEvaluation(manifest: EvaluationManifest, root: string, options?: {
    fixturesRoot?: string;
    minAcceptancePassRate?: number;
    maxRepairRate?: number;
    maxEscalationRate?: number;
}): Promise<EvaluationReport>;
export declare function persistEvaluationReport(report: EvaluationReport, filePath: string): Promise<void>;
export declare function loadEvaluationManifest(filePath: string): Promise<EvaluationManifest>;
//# sourceMappingURL=runner.d.ts.map