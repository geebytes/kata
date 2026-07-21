export interface EvaluationRun {
    id: string;
    taskId: string;
    acceptances: number;
    acceptancesPassed: number;
    acceptancesFailed: number;
    repairCount: number;
    escalationCount: number;
    tokensUsed: number;
    costCredits: number;
    latencyMs: number;
    wikiRejected: number;
    wikiPromoted: number;
}
export interface EvaluationMetrics {
    acceptancePassRate: number;
    repairRate: number;
    escalationRate: number;
    avgCostPerTask: number;
    avgLatencyMs: number;
    wikiRejectionRate: number;
    totalTasks: number;
    totalAcceptances: number;
    totalPassed: number;
    totalFailed: number;
    totalRepairs: number;
    totalEscalations: number;
    totalTokens: number;
    totalCost: number;
    totalLatencyMs: number;
    totalWikiRejected: number;
    totalWikiPromoted: number;
}
export declare function computeMetrics(runs: EvaluationRun[]): EvaluationMetrics;
//# sourceMappingURL=metrics.d.ts.map