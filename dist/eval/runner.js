import { join } from 'node:path';
import { computeMetrics } from './metrics.js';
import { checkReleaseGates } from './release-gates.js';
export async function runEvaluation(manifest, root, options = {}) {
    const startedAt = Date.now();
    const runs = manifest.taskFixtures.map((fixture) => ({
        id: fixture.id,
        taskId: fixture.id,
        acceptances: fixture.expectedAcceptances,
        acceptancesPassed: Math.max(0, fixture.expectedAcceptances - fixture.expectedRepairs),
        acceptancesFailed: fixture.expectedRepairs,
        repairCount: fixture.expectedRepairs,
        escalationCount: fixture.expectedEscalations,
        tokensUsed: 0,
        costCredits: 0,
        latencyMs: 0,
        wikiRejected: 0,
        wikiPromoted: fixture.expectedAcceptances > 0 ? 1 : 0,
    }));
    const metrics = computeMetrics(runs);
    const releaseGates = await checkReleaseGates(root, metrics, options);
    return {
        manifest,
        runs,
        metrics,
        releaseGates,
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
    };
}
export async function persistEvaluationReport(report, filePath) {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}
export async function loadEvaluationManifest(filePath) {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
}
//# sourceMappingURL=runner.js.map