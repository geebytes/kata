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
 * **A record is filed under the revision the round read, not the revision in hand when it is recorded.**
 *
 * Both facts matter and they are different facts: `revisionId` is the content the conclusion is bound to (the seal it
 * answered), `reviewedRevisionId` is the revision the round actually read. A stamp taken only at record time cannot tell a
 * second round over one revision from the same round recorded twice — measured on a real change this session, where the
 * only way to open the slot was to restate a claim, a change to the question made for no other reason than bookkeeping.
 */
const changeId = 'filed-under-the-rounds-revision';
let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-filed-under-'));
    await initLayout(root);
    await createTask({ root, id: changeId, title: 'Filed under the round', acceptance: [{ id: 'AC-1', statement: 'Filed.' }], ownedPaths: ['src/a.ts'] });
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'tmp'), { recursive: true });
    await mkdir(join(root, '.kata', 'evidence'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');
    await writePolicy(root, changeId, defaultPolicy());
    const frozen = await freezeSubject({ root, paths: ['src/a.ts'] });
    if (!frozen.ok) throw new Error(frozen.error);
    await writeSubject(root, changeId, frozen.subject);
    await appendClaim(root, changeId, {
        id: 'C-1', statement: 'The export is present.', riskClass: 'consistency', severity: 'major',
        dependsOn: ['path:src/a.ts'], evidenceIds: [], challengeIds: [], status: 'open', at: '2026-10-11T00:00:00.000Z', reopens: 0,
    });
    await writePlan(root, changeId, {
        tier: 'strict',
        readingSets: [{ claimId: 'C-1', paths: ['src/a.ts'], truncated: false }],
        requiredEvidence: [{ claimId: 'C-1', types: [], minimumStrength: 0 }],
        discovery: { deadlineToolCalls: null },
    });
    await writeCurrentState(root, { taskId: changeId, phase: 'hardVerify', actor: { id: 'kata-agent', role: 'implementer' }, updatedAt: '2026-10-11T00:00:00.000Z' });
});

afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
});

async function seal(): Promise<string> {
    await createTaskRevisionIfChanged({ root, taskId: changeId, ownedPaths: ['src/a.ts'], checkIds: [] });
    const sealed = JSON.parse(await readFile(join(root, '.kata', 'tasks', changeId, 'current-revision.json'), 'utf8')) as { id: string };
    await writeFile(join(root, '.kata', 'evidence', `${changeId}-test.json`), `${JSON.stringify({
        id: 'evidence-1', taskId: changeId, checkId: 'check-1', checkSource: 'configured', name: 'test', kind: 'test',
        command: 'true', environment: 'test', exitCode: 0, passed: true, checkInput: 'a'.repeat(64), coveredAcceptanceIds: [],
        startedAt: '2026-10-11T00:00:00.000Z', finishedAt: '2026-10-11T00:00:01.000Z', diffHash: 'd'.repeat(64), log: '', logBytes: 0,
        revisionId: sealed.id,
    })}\n`);
    return sealed.id;
}

async function record(id: string, file: string): Promise<{ success?: boolean; error?: string }> {
    await writeFile(join(root, 'tmp', file), `${JSON.stringify({
        findings: [{ id, taskId: changeId, severity: 'major', message: `${id} found something real.`, acceptanceId: 'AC-1', reproduction: { findingId: id, ranChecks: [], missingTest: true } }],
        declaredCoverage: ['C-1'],
    })}\n`);
    return runCommand('review', changeId, root, { reviewResultFile: `tmp/${file}` }) as Promise<{ success?: boolean; error?: string }>;
}

const readRecord = async (): Promise<Record<string, unknown>> => JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as Record<string, unknown>;

describe('a record is filed under the revision the round read', () => {
    it('carries both facts: the content it answers and the revision the round read', async () => {
        const first = await seal();
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);
        expect((await record('F-1', 'round-1.json')).success).toBe(true);
        const one = await readRecord();
        expect(one.revisionId).toBe(first);
        expect(one.reviewedRevisionId, 'the round read the revision its placeholder was bound to').toBe(first);

        // The content moves *after* the round was opened: the record answers the new content (the binding at record time)
        // while still naming the revision the round read. Neither field can stand in for the other.
        await writeFile(join(root, 'src', 'a.ts'), 'export const holds = false;\n');
        const second = await seal();
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);
        expect((await record('F-2', 'round-2.json')).success).toBe(true);
        const two = await readRecord();
        expect(two.findings).toEqual([expect.objectContaining({ id: 'F-2' })]);
        expect(two.revisionId).toBe(second);
        expect(two.reviewedRevisionId).toBe(second);
    });

    it('lets two rounds over one revision be two rounds, with the first in the history', async () => {
        const first = await seal();
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);
        expect((await record('F-1', 'round-1.json')).success).toBe(true);

        // The second round reads the *same* revision under the *same* request — the state that had no way in before.
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success, 'entering review is not a refusal').toBe(true);
        const two = await record('F-2', 'round-2.json');
        expect(two.success, JSON.stringify(two).slice(0, 200)).toBe(true);

        const current = await readRecord();
        expect(current.findings).toEqual([expect.objectContaining({ id: 'F-2' })]);
        expect(current.reviewedRevisionId).toBe(first);
        const rows = (await readFile(join(taskDir(root, changeId), 'review-history.jsonl'), 'utf8')).trim().split('\n').filter(Boolean)
            .map((line) => JSON.parse(line) as { findings?: Array<{ id?: string }>; reviewedRevisionId?: string });
        expect(rows.map((row) => (row.findings ?? []).map((finding) => finding.id))).toEqual([['F-1']]);
        expect(rows[0]?.reviewedRevisionId, 'the archived round names what it read').toBe(first);
    });
});
