import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLayout, reviewPath, taskDir } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { writeCurrentState } from '../../src/core/state.js';
import { appendClaim, writePlan, writePolicy } from '../../src/store/ledger.js';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';

/**
 * **A refusal has to name the road that works — and its claims about the mechanism have to be true.**
 *
 * Measured by replaying four historical rounds into one revision: the first was filed, the rest were refused with
 * *"A second round needs a different request: restate a claim … Re-entering review does not clear a recorded round, so it is
 * not offered as a remedy here."* Both halves were overtaken by this change — entering review **does** archive the record
 * standing now and open a new round, and that is the direct road for a second result over one revision. A refusal that
 * sends the operator down a road the mechanism no longer requires (and asserts something the mechanism contradicts) is the
 * defect this file exists to catch, and the positive control follows the printed remedy to prove it lands.
 */
const changeId = 'a-refusal-names-the-road-that-works';
let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-refusal-road-'));
    await initLayout(root);
    await createTask({ root, id: changeId, title: 'Refusal road', acceptance: [{ id: 'AC-1', statement: 'Filed.' }], ownedPaths: ['src/a.ts'] });
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'tmp'), { recursive: true });
    await mkdir(join(root, '.kata', 'evidence'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');
    await writePolicy(root, changeId, defaultPolicy());
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
    // Through the real verbs, so the frozen subject carries the question — a hand-frozen subject leaves the request
    // underivable and the round cannot be recorded at all (the same trap measured in the sibling selector).
    expect((await ledgerJson(['plan', '--change', changeId])).ok).toBe(true);
    expect((await ledgerJson(['freeze', '--change', changeId])).ok).toBe(true);
    await writeCurrentState(root, { taskId: changeId, phase: 'hardVerify', actor: { id: 'kata-agent', role: 'implementer' }, updatedAt: '2026-10-11T00:00:00.000Z' });
});

afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
});

async function ledgerJson(argv: string[]): Promise<{ ok?: boolean; error?: string; revision?: string }> {
    const chunks: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
    });
    const previousExitCode = process.exitCode;
    try {
        await runLedgerCommand(argv, { root, changeId });
    } finally {
        stdout.mockRestore();
        process.exitCode = previousExitCode;
    }
    const line = chunks.join('').trim().split('\n').filter((entry) => entry.trim().startsWith('{')).at(-1);
    return line ? (JSON.parse(line) as { ok?: boolean; error?: string; revision?: string }) : {};
}

async function seal(): Promise<void> {
    await createTaskRevisionIfChanged({ root, taskId: changeId, ownedPaths: ['src/a.ts'], checkIds: [] });
    const sealed = JSON.parse(await readFile(join(root, '.kata', 'tasks', changeId, 'current-revision.json'), 'utf8')) as { id: string };
    await writeFile(join(root, '.kata', 'evidence', `${changeId}-test.json`), `${JSON.stringify({
        id: 'evidence-1', taskId: changeId, checkId: 'check-1', checkSource: 'configured', name: 'test', kind: 'test',
        command: 'true', environment: 'test', exitCode: 0, passed: true, checkInput: 'a'.repeat(64), coveredAcceptanceIds: [],
        startedAt: '2026-10-11T00:00:00.000Z', finishedAt: '2026-10-11T00:00:01.000Z', diffHash: 'd'.repeat(64), log: '', logBytes: 0,
        revisionId: sealed.id,
    })}\n`);
}

async function record(id: string, file: string): Promise<{ success?: boolean; error?: string }> {
    await writeFile(join(root, 'tmp', file), `${JSON.stringify({
        findings: [{ id, taskId: changeId, severity: 'major', message: `${id} found something real.`, acceptanceId: 'AC-1', reproduction: { findingId: id, ranChecks: [], missingTest: true } }],
        declaredCoverage: ['C-1'],
    })}\n`);
    return runCommand('review', changeId, root, { reviewResultFile: `tmp/${file}` }) as Promise<{ success?: boolean; error?: string }>;
}

const historyRows = async (): Promise<Array<{ findings?: Array<{ id?: string }> }>> =>
    (await readFile(join(taskDir(root, changeId), 'review-history.jsonl'), 'utf8')).trim().split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as { findings?: Array<{ id?: string }> });

describe('a refusal names the road that works', () => {
    it('sends the operator to re-entering review, and no longer claims re-entry is inert', async () => {
        await seal();
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);
        expect((await record('F-1', 'round-1.json')).success).toBe(true);

        const second = await record('F-2', 'round-2.json');
        expect(second.success, 'a second result in one round is refused').toBe(false);
        const message = String(second.error);
        expect(message, 'the refused road must be named').toContain(`kata-cli review --change ${changeId}`);
        expect(message, 'and it must stop asserting the opposite of what the entry does')
            .not.toMatch(/does not clear a recorded round/i);
        // The remedy it does keep is the one for a *different* problem, and the message says so.
        expect(message).toMatch(/If the question itself is what should move/i);
    });

    it('names a road this state allows, when the standing record was accepted', async () => {
        // **The major an independent round found**: the message named re-entry unconditionally, but the entry refuses
        // re-entry over an approved record that still binds the current content — so in *this* state the printed road
        // refuses, which is the class this whole file is about, one layer deeper.
        await seal();
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);
        expect((await record('F-1', 'round-1.json')).success).toBe(true);
        const recorded = JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as Record<string, unknown>;
        await writeFile(reviewPath(root, changeId), `${JSON.stringify({ ...recorded, status: 'approved', reviewEvidence: 'accepted for this content' }, null, 2)}\n`);

        const second = await record('F-2', 'round-2.json');
        expect(second.success).toBe(false);
        const message = String(second.error);
        // The road it must not offer …
        expect(message, 're-entry is refused in this state, so it cannot be the named road').toContain('would move an accepted conclusion');
        // … and the roads that do work here.
        expect(message).toMatch(/build --seal/);
        expect(message).toMatch(/kata-cli archive --change/);
        expect(message, 'a changed question is a new request, and its round may be recorded').toMatch(/restate a claim/);
    });

    it('lands: following the printed remedy files the next round and archives the first', async () => {
        await seal();
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);
        expect((await record('F-1', 'round-1.json')).success).toBe(true);

        // **The remedy, followed literally**: enter review again.
        expect((await runCommand('review', changeId, root, { confirmHostModel: true })).success).toBe(true);
        expect((await record('F-2', 'round-2.json')).success).toBe(true);

        const rows = await historyRows();
        expect(rows.map((row) => (row.findings ?? []).map((finding) => finding.id))).toEqual([['F-1']]);
        const standing = JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as { findings?: Array<{ id?: string }> };
        expect(standing.findings?.map((finding) => finding.id)).toEqual(['F-2']);
    });
});
