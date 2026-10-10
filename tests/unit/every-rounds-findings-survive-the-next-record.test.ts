import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLayout, reviewPath, taskDir } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { writeCurrentState } from '../../src/core/state.js';
import { appendClaim, freezeSubject, writePlan, writePolicy, writeSubject } from '../../src/store/ledger.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';

/**
 * **A round's findings survive the next record.**
 *
 * Measured on a real change this session: ten review rounds were recorded through the managed path, and two of them —
 * rounds 4 and 6 — have no record anywhere in `.kata` (`R6-F1`: zero hits; `R4-F1` only mentioned inside another round's
 * message). Every round was recorded, so nothing was skipped: a record was **replaced without being archived**, and the
 * round it described vanished from the store of record.
 *
 * The property this case asserts is the one a reader depends on: after several rounds over one revision, the history holds
 * one row per replaced round and every round's finding ids appear in it exactly once. Counting rows is not enough — a row
 * with an empty `findings` array is exactly the shape the loss produced.
 */
const changeId = 'rounds-survive';
let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-rounds-survive-'));
    await initLayout(root);
    await createTask({
        root,
        id: changeId,
        title: 'A round survives',
        acceptance: [{ id: 'AC-1', statement: 'The round survives.' }],
        ownedPaths: ['src/a.ts'],
    });
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'tmp'), { recursive: true });
    await mkdir(join(root, '.kata', 'evidence'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');
});

afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
});

async function prepareRequest(): Promise<void> {
    await writePolicy(root, changeId, defaultPolicy());
    const frozen = await freezeSubject({ root, paths: ['src/a.ts'] });
    if (!frozen.ok) throw new Error(frozen.error);
    await writeSubject(root, changeId, frozen.subject);
    await appendClaim(root, changeId, {
        id: 'C-1',
        statement: 'The export is present.',
        riskClass: 'consistency',
        severity: 'major',
        dependsOn: ['path:src/a.ts'],
        evidenceIds: [],
        challengeIds: [],
        status: 'open',
        at: '2026-10-11T00:00:00.000Z',
        reopens: 0,
    });
    await writePlan(root, changeId, {
        tier: 'strict',
        readingSets: [{ claimId: 'C-1', paths: ['src/a.ts'], truncated: false }],
        requiredEvidence: [{ claimId: 'C-1', types: [], minimumStrength: 0 }],
        discovery: { deadlineToolCalls: null },
    });
}

/** Seal whatever the tree holds now, as the workflow does, and return the revision id. */
async function seal(): Promise<string> {
    await createTaskRevisionIfChanged({ root, taskId: changeId, ownedPaths: ['src/a.ts'], checkIds: [] });
    const sealed = JSON.parse(await readFile(join(root, '.kata', 'tasks', changeId, 'current-revision.json'), 'utf8')) as { id: string };
    // **The archival branch needs a revision id, and it takes one from recorded evidence.** A hand-written envelope the
    // evidence reader refuses leaves `revisionIdForEvidence` undefined, and the branch that archives short-circuits — so a
    // fixture whose evidence is not a record the engine can read cannot drive the code under test.
    await writeFile(join(root, '.kata', 'evidence', `${changeId}-test.json`), `${JSON.stringify({
        id: 'evidence-1', taskId: changeId, checkId: 'check-1', checkSource: 'configured', name: 'test',
        kind: 'test', command: 'true', environment: 'test', exitCode: 0, passed: true,
        checkInput: 'a'.repeat(64), coveredAcceptanceIds: [], startedAt: '2026-10-11T00:00:00.000Z',
        finishedAt: '2026-10-11T00:00:01.000Z', diffHash: 'd'.repeat(64), log: '', logBytes: 0,
        revisionId: sealed.id,
    })}\n`);
    return sealed.id;
}

/** Enter review, the way the workflow does, so the round has a placeholder to record against. */
async function enterReview(): Promise<void> {
    const entered = await runCommand('review', changeId, root, { confirmHostModel: true });
    expect(entered.success, JSON.stringify(entered).slice(0, 300)).toBe(true);
}

/** Record one round's result through the CLI path, and report the envelope rather than swallowing it. */
async function recordRound(id: string, file: string): Promise<{ success?: boolean; error?: string }> {
    await writeFile(join(root, 'tmp', file), `${JSON.stringify({
        findings: [{
            id,
            taskId: changeId,
            severity: 'major',
            message: `${id} found something real.`,
            // A merge-blocking severity names its basis (AC-6 of the defect-classes change), and this round cites the
            // criterion it found false.
            acceptanceId: 'AC-1',
            reproduction: { findingId: id, ranChecks: [], missingTest: true },
        }],
        declaredCoverage: ['C-1'],
    })}\n`);
    return runCommand('review', changeId, root, { reviewResultFile: `tmp/${file}` }) as Promise<{ success?: boolean; error?: string }>;
}

async function historyRows(): Promise<Array<{ findings?: Array<{ id?: string }>; revisionId?: string }>> {
    const raw = await readFile(join(taskDir(root, changeId), 'review-history.jsonl'), 'utf8').catch(() => '');
    return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { findings?: Array<{ id?: string }> });
}

describe('a round survives the next record', () => {
    it('keeps every round its own record when the rounds share one revision', async () => {
        await prepareRequest();
        await writeCurrentState(root, { taskId: changeId, phase: 'hardVerify', actor: { id: 'kata-agent', role: 'implementer' }, updatedAt: '2026-10-11T00:00:00.000Z' });
        const first = await seal();
        await enterReview();
        const one = await recordRound('F-1', 'round-1.json');
        expect(one.success, JSON.stringify(one).slice(0, 300)).toBe(true);

        // A second round over the same content and the same request: the workflow enters review again (it does not refuse to),
        // and the round's result is recorded. This is the pair of rounds that a stamp taken at record time cannot tell apart.
        await enterReview();
        const two = await recordRound('F-2', 'round-2.json');
        expect(two.success, JSON.stringify(two).slice(0, 300)).toBe(true);

        const record = JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as { findings?: Array<{ id?: string }>; revisionId?: string; reviewedRevisionId?: string };
        // The store holds the second round, and the first round's findings are not gone: they are in the history.
        expect(record.findings?.map((finding) => finding.id)).toEqual(['F-2']);
        expect(record.revisionId).toBe(first);
        const archived = await historyRows();
        expect(archived.map((row) => (row.findings ?? []).map((finding) => finding.id))).toEqual([['F-1']]);
    });

    it('keeps every round its own record when the content moves between them', async () => {
        await prepareRequest();
        await writeCurrentState(root, { taskId: changeId, phase: 'hardVerify', actor: { id: 'kata-agent', role: 'implementer' }, updatedAt: '2026-10-11T00:00:00.000Z' });
        await seal();
        await enterReview();
        expect((await recordRound('F-1', 'round-1.json')).success).toBe(true);

        await writeFile(join(root, 'src', 'a.ts'), 'export const holds = false;\n');
        const second = await seal();
        await enterReview();
        expect((await recordRound('F-2', 'round-2.json')).success).toBe(true);

        const record = JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as { findings?: Array<{ id?: string }>; revisionId?: string };
        expect(record.findings?.map((finding) => finding.id)).toEqual(['F-2']);
        expect(record.revisionId).toBe(second);
        const ids = (await historyRows()).flatMap((row) => (row.findings ?? []).map((finding) => finding.id));
        expect(ids, 'the round that was replaced must be in the history').toEqual(['F-1']);
    });
});
