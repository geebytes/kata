export function computeMetrics(runs) {
    const totals = runs.reduce((acc, run) => ({
        tasks: acc.tasks + 1,
        acceptances: acc.acceptances + run.acceptances,
        passed: acc.passed + run.acceptancesPassed,
        failed: acc.failed + run.acceptancesFailed,
        repairs: acc.repairs + run.repairCount,
        escalations: acc.escalations + run.escalationCount,
        tokens: acc.tokens + run.tokensUsed,
        cost: acc.cost + run.costCredits,
        latency: acc.latency + run.latencyMs,
        wikiRejected: acc.wikiRejected + run.wikiRejected,
        wikiPromoted: acc.wikiPromoted + run.wikiPromoted,
    }), { tasks: 0, acceptances: 0, passed: 0, failed: 0, repairs: 0, escalations: 0, tokens: 0, cost: 0, latency: 0, wikiRejected: 0, wikiPromoted: 0 });
    return {
        acceptancePassRate: totals.acceptances > 0 ? totals.passed / totals.acceptances : 0,
        repairRate: totals.tasks > 0 ? totals.repairs / totals.tasks : 0,
        escalationRate: totals.tasks > 0 ? totals.escalations / totals.tasks : 0,
        avgCostPerTask: totals.tasks > 0 ? totals.cost / totals.tasks : 0,
        avgLatencyMs: totals.tasks > 0 ? totals.latency / totals.tasks : 0,
        wikiRejectionRate: totals.wikiPromoted + totals.wikiRejected > 0
            ? totals.wikiRejected / (totals.wikiPromoted + totals.wikiRejected)
            : 0,
        totalTasks: totals.tasks,
        totalAcceptances: totals.acceptances,
        totalPassed: totals.passed,
        totalFailed: totals.failed,
        totalRepairs: totals.repairs,
        totalEscalations: totals.escalations,
        totalTokens: totals.tokens,
        totalCost: totals.cost,
        totalLatencyMs: totals.latency,
        totalWikiRejected: totals.wikiRejected,
        totalWikiPromoted: totals.wikiPromoted,
    };
}
//# sourceMappingURL=metrics.js.map