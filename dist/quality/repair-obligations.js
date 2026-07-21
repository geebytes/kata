import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { evidenceMatchesRow, getMatrixRowForAc } from './acceptance-matrix.js';
export async function readObligations(root, taskId) {
    try {
        const raw = await readFile(obligationsPath(root, taskId), 'utf8');
        return JSON.parse(raw).obligations;
    }
    catch {
        return [];
    }
}
export async function hasUnresolvedObligations(root, taskId) {
    const obligations = await readObligations(root, taskId);
    return obligations.some((o) => !o.resolvedAt);
}
export async function persistBlockingFindings(root, taskId, findings) {
    const existing = await readObligations(root, taskId);
    const now = new Date().toISOString();
    const newObligations = [];
    for (const finding of findings) {
        if (finding.severity !== 'blocking')
            continue;
        const existingObligation = existing.find((o) => o.findingId === finding.id && !o.resolvedAt);
        if (existingObligation)
            continue;
        const obligation = {
            id: `obligation-${crypto.randomUUID()}`,
            taskId,
            source: 'review',
            findingId: finding.id,
            ...(finding.acceptanceId ? { acceptanceId: finding.acceptanceId } : {}),
            severity: 'blocking',
            message: finding.message,
            createdAt: now,
        };
        newObligations.push(obligation);
    }
    const merged = [...existing, ...newObligations];
    await writeObligations(root, taskId, merged);
    return newObligations;
}
export async function persistBlockingJudgeResult(root, taskId, acceptanceResults) {
    const existing = await readObligations(root, taskId);
    const now = new Date().toISOString();
    const newObligations = [];
    for (const ac of acceptanceResults) {
        if (ac.result !== 'FAIL')
            continue;
        const existingObligation = existing.find((o) => o.acceptanceId === ac.id && o.source === 'judge' && !o.resolvedAt);
        if (existingObligation)
            continue;
        const obligation = {
            id: `obligation-${crypto.randomUUID()}`,
            taskId,
            source: 'judge',
            acceptanceId: ac.id,
            severity: 'blocking',
            message: `Judge FAIL for ${ac.id}`,
            createdAt: now,
        };
        newObligations.push(obligation);
    }
    const merged = [...existing, ...newObligations];
    await writeObligations(root, taskId, merged);
    return newObligations;
}
export async function resolveObligationsForRevision(root, taskId, revisionId, resolvedAcceptanceIds, evidenceIds, matrix, evidence = []) {
    const existing = await readObligations(root, taskId);
    const now = new Date().toISOString();
    let changed = false;
    for (const obligation of existing) {
        if (obligation.resolvedAt)
            continue;
        const row = obligation.acceptanceId ? getMatrixRowForAc(matrix, obligation.acceptanceId) : undefined;
        const matchedEvidence = matrix && row
            ? evidence.filter((item) => item.exitCode === 0 && evidenceMatchesRow(row, item.command, item.kind))
            : evidence.filter((item) => evidenceIds.includes(item.id) && item.exitCode === 0);
        const hasMappedEvidence = !matrix || matchedEvidence.length > 0;
        if (obligation.acceptanceId && resolvedAcceptanceIds.includes(obligation.acceptanceId) && hasMappedEvidence) {
            obligation.resolvedAt = now;
            obligation.resolvedByRevisionId = revisionId;
            obligation.resolvedEvidenceIds = matchedEvidence.map((item) => item.id);
            changed = true;
        }
    }
    if (changed) {
        await writeObligations(root, taskId, existing);
    }
    return existing;
}
export async function reopenObligation(root, taskId, obligationId) {
    const existing = await readObligations(root, taskId);
    const obligation = existing.find((o) => o.id === obligationId);
    if (!obligation)
        return false;
    obligation.resolvedAt = undefined;
    obligation.resolvedByRevisionId = undefined;
    obligation.resolvedEvidenceIds = undefined;
    await writeObligations(root, taskId, existing);
    return true;
}
function obligationsPath(root, taskId) {
    return join(root, '.kata/tasks', taskId, 'repair-obligations.json');
}
async function writeObligations(root, taskId, obligations) {
    await mkdir(join(root, '.kata/tasks', taskId), { recursive: true });
    const record = {
        obligations,
        updatedAt: new Date().toISOString(),
    };
    await writeFile(obligationsPath(root, taskId), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}
//# sourceMappingURL=repair-obligations.js.map