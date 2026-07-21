import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readWikiRecords } from './store.js';
export async function ensureWikiClosure(root, taskId) {
    const existing = await readWikiClosure(root, taskId);
    if (existing)
        return existing;
    const closure = { taskId, decision: 'deferred', reason: 'Awaiting a knowledge-closure decision.', candidateIds: [], updatedAt: new Date().toISOString() };
    await persist(root, closure);
    return closure;
}
export async function readWikiClosure(root, taskId) {
    try {
        const parsed = JSON.parse(await readFile(pathFor(root, taskId), 'utf8'));
        return isWikiClosure(parsed) ? parsed : null;
    }
    catch {
        return null;
    }
}
export async function writeWikiClosure(root, taskId, input) {
    const closure = {
        taskId,
        decision: input.decision,
        reason: input.reason.trim(),
        candidateIds: [...new Set(input.candidateIds ?? [])].sort(),
        updatedAt: new Date().toISOString(),
    };
    await persist(root, closure);
    return closure;
}
export async function evaluateWikiClosure(root, taskId) {
    const closure = await readWikiClosure(root, taskId);
    if (!closure)
        return { valid: false, reason: 'missing' };
    if (!closure.reason)
        return { valid: false, reason: 'reason_required', closure };
    if (closure.decision === 'deferred')
        return { valid: false, reason: 'deferred', closure };
    if (closure.decision === 'not_applicable')
        return { valid: true, decision: 'not_applicable', closure };
    if (closure.candidateIds.length === 0)
        return { valid: false, reason: 'candidate_required', closure };
    const records = await readWikiRecords(root);
    const validIds = new Set(records.filter((record) => record.status === 'candidate' || record.status === 'verified').map((record) => record.id));
    if (closure.candidateIds.some((id) => !validIds.has(id)))
        return { valid: false, reason: 'candidate_missing', closure };
    return { valid: true, decision: 'captured', closure };
}
function pathFor(root, taskId) {
    return join(root, '.kata/tasks', taskId, 'wiki-closure.json');
}
async function persist(root, closure) {
    await mkdir(join(root, '.kata/tasks', closure.taskId), { recursive: true });
    await writeFile(pathFor(root, closure.taskId), `${JSON.stringify(closure, null, 2)}\n`, 'utf8');
}
function isWikiClosure(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const closure = value;
    return typeof closure.taskId === 'string'
        && (closure.decision === 'captured' || closure.decision === 'not_applicable' || closure.decision === 'deferred')
        && typeof closure.reason === 'string'
        && Array.isArray(closure.candidateIds)
        && closure.candidateIds.every((id) => typeof id === 'string')
        && typeof closure.updatedAt === 'string';
}
//# sourceMappingURL=closure.js.map