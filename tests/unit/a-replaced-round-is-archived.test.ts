import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLayout, reviewPath, taskDir } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { writeCurrentState } from '../../src/core/state.js';
import { appendClaim, restateClaim, writePlan, writePolicy } from '../../src/store/ledger.js';
import { runLedgerCommand } from '../../src/cli/ledger.js';
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
    // **Frozen through the real verbs**, because the frozen subject has to carry the question: a hand-frozen subject with no
    // `claimsDigest` leaves `subjectAsDeclared` underivable, so a recorded round carries no `subjectRevision`, and the
    // request-move road cannot be reached at all — the fixture would be testing its own shortcut (measured by an independent
    // round, and the same trap this repository has hit twice: a fixture that skips the path under test).
    const planned = await ledgerJson(['plan', '--change', changeId]);
    expect(planned.ok, JSON.stringify(planned).slice(0, 200)).toBe(true);
    const frozen = await ledgerJson(['freeze', '--change', changeId]);
    expect(frozen.ok, JSON.stringify(frozen).slice(0, 200)).toBe(true);
    await writeCurrentState(root, { taskId: changeId, phase: 'hardVerify', actor: { id: 'kata-agent', role: 'implementer' }, updatedAt: '2026-10-11T00:00:00.000Z' });
});

afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
});

/** A ledger verb's own envelope: the command prints its answer, so the answer is what is read. */
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

    it('archives through the result path when the request moved, and names what superseded it', async () => {
        await seal();
        await waitFor('enter review', runCommand('review', changeId, root, { confirmHostModel: true }));
        await waitFor('record round 1', record('F-1', 'round-1.json'));
        // **The road this case names is the result path** (an earlier version drove the entry, which archives
        // unconditionally and so proved nothing about the request move — measured by an independent round). The question
        // moves, no new entry happens, and the next result lands on the record that answered the old question.
        await restateClaim(root, changeId, 'C-1', 'The export is present, and stays present.');
        await waitFor('record round 2 without a new entry', record('F-2', 'round-2.json'));
        const archived = await rows();
        expect(archived).toHaveLength(1);
        expect((archived[0]?.findings as Array<{ id?: string }> | undefined)?.map((finding) => finding.id)).toEqual(['F-1']);
        // **The row names what superseded it, and the name is the fact itself** — not "a non-empty string": an earlier
        // version asserted only non-emptiness, and a fixed wrong value stayed green (measured by an independent round). The
        // subject that moved is the new question the record now answers, so the row must carry *that* value; the seal is
        // the revision being recorded against, which resolves under `.kata/tasks/<id>/revisions/`.
        const current = JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as { subjectRevision?: string; revisionId?: string };
        expect(archived[0]?.supersededBy, JSON.stringify(archived[0])).toBe(current.subjectRevision);
        expect(archived[0]?.supersededByRevision).toBe(current.revisionId);
        expect(String(archived[0]?.supersededBy).startsWith('rev:'), 'a subject revision names the question').toBe(true);
        expect(typeof archived[0]?.archivedAt).toBe('string');
        // And the declaration travels on this road too, not only on the entry road (the same round measured that the result
        // path dropped it).
        expect(archived[0]?.declaredCoverage).toEqual(['C-1']);
    });

    it('archives through the entry when the request moved, and names the revision it opens against', async () => {
        await seal();
        await waitFor('enter review', runCommand('review', changeId, root, { confirmHostModel: true }));
        await waitFor('record round 1', record('F-1', 'round-1.json'));
        await restateClaim(root, changeId, 'C-1', 'The export is present, and stays present.');
        await waitFor('enter review after the restatement', runCommand('review', changeId, root, { confirmHostModel: true }));
        const archived = await rows();
        expect(archived).toHaveLength(1);
        expect((archived[0]?.findings as Array<{ id?: string }> | undefined)?.map((finding) => finding.id)).toEqual(['F-1']);
        expect(archived[0]?.supersededByRevision, JSON.stringify(archived[0])).toBe(
            JSON.parse(await readFile(join(root, '.kata', 'tasks', changeId, 'current-revision.json'), 'utf8')).id as string,
        );
        // And the archive carries the **whole** record: `reviewRoute` is what tells a round from a placeholder, and an
        // allow-list row dropped it (measured by an independent round).
        expect(archived[0]?.reviewRoute).toBe('adversarial');
        expect(archived[0]?.declaredCoverage).toEqual(['C-1']);
        expect(typeof archived[0]?.reviewedRevisionId).toBe('string');
    });
});
