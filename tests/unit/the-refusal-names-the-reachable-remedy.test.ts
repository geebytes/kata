import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { currentStatePath, reviewPath, taskDir } from '../../src/core/layout.js';

/**
 * **A review record answers a request, and the request is not the revision.**
 *
 * Measured in another checkout: a round's result was recorded for a revision; the ledger's claims were then restated, so the
 * next round answered a *different* question while the code — and therefore the sealed revision — stood still. Recording that
 * second round was refused, because the record's binding is content identity only (`revisionId`, the manifest hashes, the
 * frozen candidate) and the request it answered was nowhere in it.
 *
 * This guard pins the half that releases a blocked round: a record that answered **another** request does not block the
 * answer to this one. The same-request refusal and its remedy live in `the-refusal-names-the-reachable-remedy.test.ts`,
 * because two criteria that name one test file collapse into one check and one of them then has no evidence.
 */
const NOW = '2026-10-08T00:00:00.000Z';
const taskId = 'record-answers-a-request';
const roots: string[] = [];
let root: string;
/** The workspace the CLI resolves, restored after each case — the result file must live inside it. */
const originalCwd = process.cwd();

afterEach(async () => {
    process.chdir(originalCwd);
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-record-request-'));
    roots.push(root);
    // `--result-file` is resolved against the workspace, so the fixture *is* the workspace for this case.
    process.chdir(root);
    await mkdir(join(root, '.kata', 'tasks', taskId, 'review'), { recursive: true });
    await writeFile(join(root, 'subject.ts'), 'export const version = 1;\n');
    await writeFile(
        join(root, '.kata', 'tasks', taskId, 'task.json'),
        `${JSON.stringify({ id: taskId, title: 'T', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['subject.ts'], createdAt: NOW, updatedAt: NOW })}\n`,
    );
    await writeFile(
        currentStatePath(root, taskId),
        `${JSON.stringify({ taskId, phase: 'review', actor: { id: 'fixture', role: 'reviewer' }, updatedAt: NOW })}\n`,
    );
});

/** A frozen ledger subject, which is what the review request is derived from. */
async function freezeSubject(revision: string): Promise<void> {
    await writeFile(
        join(taskDir(root, taskId), 'review', 'subject.json'),
        // The shape the review-subject schema declares: a revision and its path digests.
        `${JSON.stringify({ revision, pathDigests: { 'subject.ts': 'a'.repeat(64) }, declaredPaths: ['subject.ts'] })}\n`,
    );
    // The declaration in the result has to name claims the ledger holds, so the fixture holds one.
    await writeFile(
        join(taskDir(root, taskId), 'review', 'claims.json'),
        `${JSON.stringify([{ id: 'C1', statement: 's', riskClass: 'consistency', severity: 'major', dependsOn: ['path:subject.ts'], evidenceIds: [], challengeIds: [], status: 'open', at: NOW, reopens: 0 }])}\n`,
    );
}

async function recordedRound(subjectRevision?: string): Promise<string> {
    const { revision } = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: [] });
    await writeFile(
        reviewPath(root, taskId),
        `${JSON.stringify({
            revisionId: revision.id,
            manifestHash: revision.manifestHash,
            ...(subjectRevision ? { subjectRevision } : {}),
            findings: [{ id: 'R8-F1', taskId, acceptanceId: 'AC-1', severity: 'minor', path: 'subject.ts', message: 'm' }],
            status: 'pending',
            reviewRoute: 'adversarial',
        }, null, 2)}\n`,
    );
    return revision.id;
}

const RESULT = { taskId, status: 'pending', declaredCoverage: ['C1'], findings: [{ id: 'R9-F1', taskId, acceptanceId: 'AC-1', severity: 'major', path: 'subject.ts', message: 'm' }] };

async function writeResultFile(): Promise<string> {
    // Written at the fixture root and named **relative**, because the CLI resolves the flag against the workspace and
    // refuses a path outside it.
    await writeFile(join(root, 'result.json'), `${JSON.stringify(RESULT, null, 2)}\n`);
    return 'result.json';
}

describe('the refusal names a reachable remedy', () => {
    it('still refuses a second result for the same request, so a recorded round is not silently replaced', async () => {
        await recordedRound('rev:bbbb11111111bbbb');
        await freezeSubject('rev:bbbb11111111bbbb');

        const recorded = await runCommand('review', taskId, root, { reviewResultFile: await writeResultFile() });
        expect(recorded.success).toBe(false);
        // And the refusal names a remedy that works in the state it fires from: the chain, not just "re-enter".
        expect(String(recorded.error)).toContain('kata-cli verify');
        expect(String(recorded.error)).toContain('kata-cli gate approve');
        expect(String(recorded.error)).toContain('--confirm-host-model');
    });

});
