import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export async function recordFinding(input) {
    const root = input.root ?? process.cwd();
    const finding = {
        id: `finding-${randomUUID()}`,
        taskId: input.taskId,
        ...(input.acceptanceId ? { acceptanceId: input.acceptanceId } : {}),
        severity: input.severity,
        message: input.message,
        ...(input.path ? { path: input.path } : {}),
    };
    const reviewPath = join(root, '.kata/tasks', input.taskId, 'review.json');
    let findings = [];
    let revisionId;
    let status;
    try {
        const parsed = JSON.parse(await readFile(reviewPath, 'utf8'));
        findings = parsed.findings ?? [];
        revisionId = parsed.revisionId;
        status = parsed.status;
    }
    catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT')
            throw error;
    }
    await mkdir(join(root, '.kata/tasks', input.taskId), { recursive: true });
    await writeFile(reviewPath, `${JSON.stringify({ ...(revisionId ? { revisionId } : {}), findings: [...findings, finding], ...(status ? { status } : { status: 'pending' }) }, null, 2)}\n`, 'utf8');
    if (finding.severity === 'blocking') {
        const { persistBlockingFindings } = await import('./repair-obligations.js');
        await persistBlockingFindings(root, input.taskId, [{
                id: finding.id,
                acceptanceId: input.acceptanceId,
                severity: finding.severity,
                message: finding.message,
            }]);
    }
    return finding;
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
//# sourceMappingURL=reviewer.js.map