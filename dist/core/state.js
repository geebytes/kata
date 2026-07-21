import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkFreshness, computeDiffHash } from '../quality/evidence.js';
import { readTaskRevision, revisionStatus } from '../workflow/revision.js';
import { assertValidTaskId } from './ids.js';
export const orderedPhases = [
    'intake',
    'plan',
    'implement',
    'hardVerify',
    'review',
    'judge',
    'distill',
    'archive',
];
export function isLegalPhaseTransition(from, to) {
    return orderedPhases.indexOf(to) === orderedPhases.indexOf(from) + 1;
}
export async function transition(taskId, to, actor, options = {}) {
    const root = options.root ?? process.cwd();
    assertValidTaskId(taskId);
    const current = await readCurrentState(root, taskId);
    if (!isLegalPhaseTransition(current.phase, to)) {
        throw new Error(`Illegal transition from ${current.phase} to ${to}`);
    }
    if (to === 'implement')
        await assertAcceptanceIds(root, taskId);
    if (to === 'distill')
        await assertDistillGates(root, taskId);
    const now = new Date().toISOString();
    const next = {
        taskId,
        phase: to,
        actor,
        updatedAt: now,
        ...(options.activeSession ? { activeSession: options.activeSession } : {}),
    };
    await appendStateEvent(root, {
        taskId,
        from: current.phase,
        to,
        actor,
        at: now,
        ...(options.activeSession ? { activeSession: options.activeSession } : {}),
    });
    await writeCurrentState(root, next);
    return next;
}
export async function appendStateEvent(root, event) {
    await appendFile(stateEventsPath(root, event.taskId), `${JSON.stringify(event)}\n`, 'utf8');
}
export async function writeCurrentState(root, state) {
    await writeFileAtomic(currentStatePath(root, state.taskId), `${JSON.stringify(state, null, 2)}\n`);
}
export async function readStateEvents(root, taskId) {
    const raw = await readFile(stateEventsPath(root, taskId), 'utf8');
    return raw
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}
async function readCurrentState(root, taskId) {
    return JSON.parse(await readFile(currentStatePath(root, taskId), 'utf8'));
}
async function assertAcceptanceIds(root, taskId) {
    const task = JSON.parse(await readFile(join(root, '.kata/tasks', taskId, 'task.json'), 'utf8'));
    if (!task.acceptance?.length || task.acceptance.some((criterion) => !/^AC-[0-9]+$/.test(criterion.id ?? ''))) {
        throw new Error('Cannot enter implement until every acceptance criterion has a stable acceptance id');
    }
}
async function assertDistillGates(root, taskId) {
    const currentDiffHash = await computeDiffHash(root);
    const freshEvidence = await getFreshPassingEvidence(root, taskId, currentDiffHash);
    const gates = await Promise.all([
        Promise.resolve(freshEvidence !== null),
        hasReviewerClearance(root, taskId, freshEvidence?.revisionId),
        hasJudgePass(root, taskId, currentDiffHash, freshEvidence),
    ]);
    if (!gates.every(Boolean)) {
        throw new Error('Cannot enter distill until fresh evidence, reviewer clearance, and judge PASS are present');
    }
}
async function getFreshPassingEvidence(root, taskId, currentDiffHash) {
    try {
        const evidence = JSON.parse(await readFile(join(root, `.kata/evidence/${taskId}-hard.json`), 'utf8'));
        if (evidence.taskId !== taskId || evidence.exitCode !== 0 || !evidence.diffHash)
            return null;
        if (evidence.revisionId) {
            const revision = await readTaskRevision(root, taskId, evidence.revisionId);
            if ((await revisionStatus(root, revision)).status !== 'current')
                return null;
            return evidence;
        }
        const freshness = checkFreshness({
            id: evidence.id ?? `${taskId}-hard`,
            taskId,
            kind: 'test',
            command: evidence.command ?? 'hard verification',
            exitCode: evidence.exitCode,
            startedAt: evidence.startedAt ?? '',
            finishedAt: evidence.finishedAt ?? '',
            diffHash: evidence.diffHash,
        }, currentDiffHash);
        return freshness.fresh ? evidence : null;
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT')
            return null;
        throw error;
    }
}
async function hasReviewerClearance(root, taskId, revisionId) {
    try {
        const review = JSON.parse(await readFile(join(root, '.kata/tasks', taskId, 'review.json'), 'utf8'));
        return Array.isArray(review.findings)
            && review.findings.every((finding) => finding.severity !== 'blocking')
            && (!revisionId || review.revisionId === revisionId);
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT')
            return false;
        throw error;
    }
}
async function hasJudgePass(root, taskId, currentDiffHash, freshEvidence) {
    try {
        const judge = JSON.parse(await readFile(join(root, '.kata/tasks', taskId, 'judge.json'), 'utf8'));
        if (judge.taskId !== taskId || judge.result !== 'PASS')
            return false;
        if (freshEvidence?.revisionId) {
            if (judge.revisionId !== freshEvidence.revisionId)
                return false;
        }
        else if (judge.diffHash !== currentDiffHash)
            return false;
        if (!freshEvidence?.id)
            return false;
        if (!Array.isArray(judge.acceptance) || judge.acceptance.length === 0)
            return false;
        if (judge.acceptance.some((criterion) => criterion.result !== 'PASS'))
            return false;
        const acceptedEvidenceIds = new Set([...(judge.evidenceIds ?? []), ...judge.acceptance.flatMap((criterion) => criterion.evidenceIds ?? [])]);
        return acceptedEvidenceIds.has(freshEvidence.id);
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT')
            return false;
        throw error;
    }
}
function currentStatePath(root, taskId) {
    assertValidTaskId(taskId);
    return join(root, '.kata/tasks', taskId, 'current-state.json');
}
function stateEventsPath(root, taskId) {
    assertValidTaskId(taskId);
    return join(root, '.kata/tasks', taskId, 'state-events.jsonl');
}
async function writeFileAtomic(path, content) {
    const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(temporaryPath, content, 'utf8');
    await rename(temporaryPath, path);
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
//# sourceMappingURL=state.js.map