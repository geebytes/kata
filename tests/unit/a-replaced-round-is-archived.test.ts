import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLayout, taskDir } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { writeCurrentState } from '../../src/core/state.js';
import { appendClaim, freezeSubject, restateClaim, writePlan, writePolicy, writeSubject } from '../../src/store/ledger.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';

/**
 * **Every replacement archives the round it replaces, and says what superseded it.**
 *
 * A record is replaced on three roads: a second round over one revision, content that moved, and a request that moved. The
 * history row is the only place the replaced round stays readable, so each road has a case here — and each asserts the row
 * carries the round's own findings, not an empty array. (An empty row is not a row: the loss this change answers was a round
 * whose findings were nowhere.)
 */
const changeId = 'replaced-round-archived';
let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-replaced-round-'));
    await initLayout(root);
    await createTask({ root, id: changeId, title: 'Replaced round', acceptance: [{ id: 'AC-1', statement: 'Archived.' }], ownedPaths: ['src/a.ts'] });
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

async function waitFor(step: string, action: Promise<{ success?: boolean; error?: string }>): Promise<Record<string, unknown>> {
    const result = await action;
    expect(result.success, `${step}: ${JSON.stringify(result).slice(0, 220)}`).toBe(true);
    return result as Record<string, unknown>;
}

async function record(id: string, file: string): Promise<{ success?: boolean; error?: string }> {
    await writeFile(join(root, 'tmp', file), `${JSON.stringify({
        findings: [{ id, taskId: changeId, severity: 'major', message: `${id} found something real.`, acceptanceId: 'AC-1', reproduction: { findingId: id, ranChecks: [], missingTest: true } }],
        declaredCoverage: ['C-1'],
    })}\n`);
    return runCommand('review', changeId, root, { reviewResultFile: `tmp/${file}` }) as Promise<{ success?: boolean; error?: string }>;
}

const rows = async (): Promise<Array<Record<string, unknown>>> =>
    (await readFile(join(taskDir(root, changeId), 'review-history.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);

describe('a replaced round is archived', () => {
    it('archives when a second round replaces the first over one revision', async () => {
        await seal();
        await waitFor('enter review', runCommand('review', changeId, root, { confirmHostModel: true }));
        await waitFor('record round 1', record('F-1', 'round-1.json'));
        await waitFor('enter review again', runCommand('review', changeId, root, { confirmHostModel: true }));
        await waitFor('record round 2', record('F-2', 'round-2.json'));
        const archived = await rows();
        expect(archived).toHaveLength(1);
        expect((archived[0]?.findings as Array<{ id?: string }> | undefined)?.map((finding) => finding.id)).toEqual(['F-1']);
    });

    it('archives when the content moved between the rounds', async () => {
        await seal();
        await waitFor('enter review', runCommand('review', changeId, root, { confirmHostModel: true }));
        await waitFor('record round 1', record('F-1', 'round-1.json'));
        await writeFile(join(root, 'src', 'a.ts'), 'export const holds = false;\n');
        await seal();
        await waitFor('enter review after the seal', runCommand('review', changeId, root, { confirmHostModel: true }));
        await waitFor('record round 2', record('F-2', 'round-2.json'));
        const archived = await rows();
        expect(archived).toHaveLength(1);
        expect((archived[0]?.findings as Array<{ id?: string }> | undefined)?.map((finding) => finding.id)).toEqual(['F-1']);
    });

    it('archives when the request moved between the rounds, and names what superseded it', async () => {
        await seal();
        await waitFor('enter review', runCommand('review', changeId, root, { confirmHostModel: true }));
        await waitFor('record round 1', record('F-1', 'round-1.json'));
        // The question moves: the same code answers a different request, which is the road the record's binding cannot see.
        await restateClaim(root, changeId, 'C-1', 'The export is present, and stays present.');
        await waitFor('enter review after the restatement', runCommand('review', changeId, root, { confirmHostModel: true }));
        const archived = await rows();
        expect(archived).toHaveLength(1);
        expect((archived[0]?.findings as Array<{ id?: string }> | undefined)?.map((finding) => finding.id)).toEqual(['F-1']);
        // The row says what superseded it, so a reader can tell a replacement from a discard.
        expect(typeof archived[0]?.supersededBy).toBe('string');
        expect(typeof archived[0]?.archivedAt).toBe('string');
    });
});
