import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initLayout, reviewPath } from '../../src/core/layout.js';
import { writeCurrentState } from '../../src/core/state.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { readLedger } from '../../src/store/ledger.js';
import { writeTaskRecord } from '../helpers/task-fixture.js';

/**
 * **AC-9 — a recorded round says which revision it reviewed.**
 *
 * The record's binding fields describe the content the round is bound to, and every one of them is derived from the
 * pointer at *record* time. So when the pointer moves while the round runs (a re-seal during the review, which is what a
 * repair produces), the round's findings are stamped with the revision the CLI happened to see when the result arrived —
 * not the one the round actually read. Nothing on disk could tell the two apart: a reader wanting to know "did this round
 * answer the content in hand?" had to reconstruct it from timestamps and file mtimes.
 *
 * Entering review writes a placeholder bound to the revision in hand, and the round that follows reviews *that* content.
 * These cases pin the two facts apart on the record itself: `reviewedRevisionId` is what the round read, the binding is
 * what it is recorded against, and they are equal exactly when nothing moved.
 */
const roots: string[] = [];
const taskId = 'round-names-its-revision';

async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-round-revision-'));
    roots.push(root);
    await initLayout(root);
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'thing.ts'), 'export const holds = true;\n');
    await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
    await writeTaskRecord(root, {
        id: taskId,
        phase: 'hardVerify',
        acceptance: [{ id: 'AC-1', statement: 'The thing holds.' }],
        ownedPaths: ['src/thing.ts'],
    });
    // The ledger is driven through its own CLI, because what approval reads is *what the ledger decided* — a fixture that
    // wrote `claims.json` and `evidence.json` by hand would be measuring its own arithmetic.
    await ledger(root, ['policy', '--init']);
    await ledger(root, ['freeze']);
    // Each required risk class carries a falsifier, because that is what the tier's request asks for: a static witness
    // alone leaves `requestGaps` naming the claim, and approval refuses until the request is satisfied.
    for (const [index, riskClass] of ['consistency', 'boundary', 'failure_mode'].entries()) {
        const claimId = `C-${index + 1}`;
        const evidenceId = `E${index + 1}`;
        await ledger(root, ['claim', 'add', '--statement', `${riskClass} holds`, '--risk-class', riskClass,
            '--severity', 'major', '--evidence', evidenceId, '--depends-on', 'path:src/thing.ts', '--id', claimId]);
        const submission = join(root, `${claimId}.json`);
        await writeFile(submission, `${JSON.stringify({ claims: [], evidence: [{
            id: evidenceId,
            type: 'executable_falsifier',
            command: 'grep -q "export const holds = true" src/thing.ts',
            mutation: { file: 'src/thing.ts', find: 'holds = true', replace: 'holds = false' },
        }] })}\n`);
        await ledger(root, ['evidence', 'add', '--file', submission]);
    }
    await ledger(root, ['evidence', 'verify']);
    // The floor wants a challenge that reproduces a declared falsifier, and persists its observation.
    await ledger(root, ['challenge', 'add', '--claim', 'C-1', '--falsifier', 'E1', '--id', 'X1']);
    await ledger(root, ['challenge', 'check']);
    // The plan is what a request is derived from, and approval asks whether that request was satisfied.
    await ledger(root, ['plan']);
    await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['src/thing.ts'], checkIds: [] });
    await writeCurrentState(root, {
        taskId,
        phase: 'hardVerify',
        actor: { id: 'kata-agent', role: 'implementer' },
        updatedAt: '2026-10-09T00:00:00.000Z',
    });
    return root;
}

async function ledger(root: string, argv: string[]): Promise<Record<string, unknown>> {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
    });
    try {
        await runLedgerCommand(argv, { root, changeId: taskId });
    } finally {
        spy.mockRestore();
    }
    const text = chunks.join('');
    const start = text.indexOf('{');
    return start < 0 ? {} : (JSON.parse(text.slice(start)) as Record<string, unknown>);
}

async function record(root: string, findings: unknown[]): Promise<{ success: boolean; error?: string }> {
    await mkdir(join(root, 'tmp'), { recursive: true });
    await writeFile(join(root, 'tmp', 'round.json'), `${JSON.stringify({ findings })}\n`);
    return await runCommand('review', taskId, root, { reviewResultFile: 'tmp/round.json' });
}

const finding = (id: string) => ({ id, taskId, severity: 'minor', message: `${id} is advisory` });

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('a recorded round says which revision it reviewed', () => {
    it('keeps the reviewed revision when the pointer moved before the result arrived', async () => {
        const root = await tempRoot();
        const entered = await runCommand('review', taskId, root, { confirmHostModel: true });
        expect(entered.success, JSON.stringify(entered)).toBe(true);
        const placeholder = JSON.parse(await readFile(reviewPath(root, taskId), 'utf8')) as { revisionId?: string };
        expect(typeof placeholder.revisionId).toBe('string');

        // A re-seal during the round: the content moves and the pointer follows it.
        await writeFile(join(root, 'src', 'thing.ts'), 'export const holds = false;\n');
        const resealed = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['src/thing.ts'], checkIds: [] });
        expect(resealed.revision.id).not.toBe(placeholder.revisionId);

        const recorded = await record(root, [finding('R-1')]);
        expect(recorded.error, JSON.stringify(recorded)).toBeUndefined();

        const review = JSON.parse(await readFile(reviewPath(root, taskId), 'utf8')) as { revisionId?: string; reviewedRevisionId?: string };
        // The two facts are told apart on the record: it reviewed the revision the round was opened against, and it is
        // recorded against the revision the pointer names now.
        expect(review.reviewedRevisionId).toBe(placeholder.revisionId);
        expect(review.revisionId).toBe(resealed.revision.id);
        expect(review.reviewedRevisionId).not.toBe(review.revisionId);
    });

    it('names the same revision twice when nothing moved, so the field is not decoration', async () => {
        const root = await tempRoot();
        expect((await runCommand('review', taskId, root, { confirmHostModel: true })).success).toBe(true);

        const recorded = await record(root, [finding('R-1')]);
        expect(recorded.error, JSON.stringify(recorded)).toBeUndefined();

        const review = JSON.parse(await readFile(reviewPath(root, taskId), 'utf8')) as { revisionId?: string; reviewedRevisionId?: string };
        const pointer = JSON.parse(await readFile(join(root, '.kata', 'tasks', taskId, 'current-revision.json'), 'utf8')) as { id: string };
        expect(review.reviewedRevisionId).toBe(pointer.id);
        expect(review.revisionId).toBe(pointer.id);
    });

    it('carries the reviewed revision into the approval and its loop round', async () => {
        // Approval refuses while the ledger describes content that has moved, so the carry-forward is asserted on the state
        // it is reachable in. The field has no fallback: before this change neither face wrote it at all.
        const root = await tempRoot();
        expect((await runCommand('review', taskId, root, { confirmHostModel: true })).success).toBe(true);
        const pointer = JSON.parse(await readFile(join(root, '.kata', 'tasks', taskId, 'current-revision.json'), 'utf8')) as { id: string };
        expect((await record(root, [finding('R-1')])).success).toBe(true);

        const approved = await runCommand('review', taskId, root, { approve: true, reviewEvidence: 'the round read the change' });
        expect(approved.success, JSON.stringify(approved)).toBe(true);

        const review = JSON.parse(await readFile(reviewPath(root, taskId), 'utf8')) as { reviewedRevisionId?: string; status?: string };
        expect(review.status).toBe('approved');
        expect(review.reviewedRevisionId).toBe(pointer.id);

        const rounds = (await readFile(join(root, '.kata', 'tasks', taskId, 'review-rounds.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { reviewedRevisionId?: string; blockingCount?: unknown });
        const approvalRound = rounds.at(-1) as { reviewedRevisionId?: string; blockingCount?: unknown };
        expect(approvalRound.reviewedRevisionId).toBe(pointer.id);
        expect(approvalRound.blockingCount).toBe(0);
    });
});
