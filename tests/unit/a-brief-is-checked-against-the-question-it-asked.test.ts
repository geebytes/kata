import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initLayout, reviewPath, reviewRequestPath } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { writeCurrentState } from '../../src/core/state.js';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { appendClaim, freezeSubject, writePlan, writePolicy, writeSubject } from '../../src/store/ledger.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { buildChangeRecord, writeChangeRecord } from '../../src/quality/change-record.js';
import { reviewRoundsPath } from '../../src/quality/repair.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';

/**
 * **A result is checked against the question that was asked, not against the state of the world when it arrives.**
 *
 * The first version derived the expected activity at result time and compared the payload with *that*. The two differ exactly
 * when they matter: a round that read the content for an hour and correctly echoed the brief it was handed was refused the
 * moment the content moved, while a round that echoed nothing at all was stamped with whatever the state had become. And
 * `focused_followup` was a word with no object — the brief said "verify the repair batch" and named no findings, no paths and
 * no closing rule, so re-reading the whole change was the only defensible reading of it.
 *
 * A brief is therefore a file (`review-request.json`), the result echoes its `requestId` and `reviewKind`, and a follow-up's
 * findings are answered one by one.
 */
let root: string;
const changeId = 'a-brief-is-checked';

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-brief-'));
    await initLayout(root);
    await createTask({
        root,
        id: changeId,
        title: 'A brief is checked against the question it asked',
        acceptance: [{ id: 'AC-1', statement: 'The brief and its answer are one question.' }],
        ownedPaths: ['src/a.ts'],
    });
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'tmp'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n');
});

afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
});

async function ledger(argv: string[]): Promise<{ ok?: boolean; error?: string; request?: Record<string, unknown> }> {
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
    }
    process.exitCode = previousExitCode;
    const line = chunks.join('').trim().split('\n').filter((entry) => entry.trim().startsWith('{')).at(-1);
    return line ? (JSON.parse(line) as { ok?: boolean; error?: string; request?: Record<string, unknown> }) : {};
}

/** A ledger the request builder can speak for: policy, a frozen subject, one claim with a plan, and a seal. */
async function prepareLedger(): Promise<{ revision: string; manifestHash: string }> {
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
        at: '2026-09-30T00:00:00.000Z',
        reopens: 0,
    });
    await writePlan(root, changeId, {
        tier: 'strict',
        readingSets: [{ claimId: 'C-1', paths: ['src/a.ts'], truncated: false }],
        requiredEvidence: [{ claimId: 'C-1', types: [], minimumStrength: 0 }],
        discovery: { deadlineToolCalls: null },
    });
    const sealed = await createTaskRevisionIfChanged({ root, taskId: changeId, ownedPaths: ['src/a.ts'], checkIds: [] });
    return { revision: sealed.revision.id, manifestHash: sealed.revision.manifestHash };
}

async function inReview(): Promise<void> {
    await writeCurrentState(root, {
        taskId: changeId,
        phase: 'review',
        actor: { id: 'kata-reviewer', role: 'reviewer' },
        updatedAt: '2026-10-12T00:00:00.000Z',
    });
}

async function sealWithRecord(content: string, baseRevisionId: string | undefined): Promise<{ id: string; manifestHash: string }> {
    await writeFile(join(root, 'src', 'a.ts'), content);
    const sealed = await createTaskRevisionIfChanged({ root, taskId: changeId, ownedPaths: ['src/a.ts'], checkIds: [] });
    const record = await buildChangeRecord({
        root,
        taskId: changeId,
        revisionId: sealed.revision.id,
        ...(baseRevisionId === undefined ? {} : { baseRevisionId }),
        ownedPaths: ['src/a.ts'],
        evidence: [{ id: 'evidence-1', checkId: 'test', exitCode: 0, passed: true }],
        claimFailures: [],
        findings: [],
        ...(sealed.revision.contentDigests ? { contentDigests: sealed.revision.contentDigests } : {}),
    });
    const written = await writeChangeRecord(root, changeId, record);
    if (typeof written !== 'string') throw new Error(`the change record was refused: ${written.refused.join('; ')}`);
    return { id: sealed.revision.id, manifestHash: sealed.revision.manifestHash };
}

describe('a review brief and its answer are one question', () => {
    it('persists the brief it hands over, and derives one identity for one question', async () => {
        await prepareLedger();

        const first = await ledger(['run', '--out', 'tmp/brief.json']);
        expect(first.ok, JSON.stringify(first)).toBe(true);
        const persisted = JSON.parse(await readFile(reviewRequestPath(root, changeId), 'utf8')) as { requestId?: string; reviewKind?: string };
        // The brief on disk is the brief that was handed over — one document, not two.
        expect(persisted).toEqual(first.request);
        expect(typeof persisted.requestId).toBe('string');
        expect(persisted.reviewKind).toBe('certification');

        // Same facts, same id: an identity that moved with the clock would be a second clock, and the check it feeds would
        // compare two of them.
        const again = await ledger(['run', '--out', 'tmp/brief-again.json']);
        expect(again.request?.requestId).toBe(persisted.requestId);
    });

    it('refuses a result that does not answer the brief, and accepts the one that does', async () => {
        await prepareLedger();
        const run = await ledger(['run', '--out', 'tmp/brief.json']);
        const brief = run.request as { requestId: string; reviewKind: string };
        await inReview();
        const finding = { id: 'R-1', taskId: changeId, severity: 'minor', message: 'a detail' };

        // **Silence is not an answer.** Without the identity there is nothing to compare the result against but the state at
        // this moment, which is the comparison the first version made — and it stamps a payload with a question its author
        // never saw.
        await writeFile(join(root, 'tmp', 'silent.json'), `${JSON.stringify({ reviewKind: brief.reviewKind, findings: [finding] })}\n`);
        const silent = await runCommand('review', changeId, root, { reviewResultFile: 'tmp/silent.json' });
        expect(silent.success).toBe(false);
        expect(silent.error).toContain(brief.requestId);
        expect(silent.error).toContain('requestId');

        // A different brief's identity is the same refusal: this result belongs to another question.
        await writeFile(join(root, 'tmp', 'other.json'), `${JSON.stringify({ requestId: 'deadbeefdeadbeef', reviewKind: brief.reviewKind, findings: [finding] })}\n`);
        const other = await runCommand('review', changeId, root, { reviewResultFile: 'tmp/other.json' });
        expect(other.success).toBe(false);
        expect(other.error).toContain('deadbeefdeadbeef');

        await writeFile(join(root, 'tmp', 'answer.json'), `${JSON.stringify({ requestId: brief.requestId, reviewKind: brief.reviewKind, findings: [finding] })}\n`);
        const answer = await runCommand('review', changeId, root, { reviewResultFile: 'tmp/answer.json' });
        expect(answer.success, JSON.stringify(answer)).toBe(true);
        const record = JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as { requestId?: string; reviewKind?: string; recordedAt?: string };
        expect(record.requestId).toBe(brief.requestId);
        expect(record.reviewKind).toBe(brief.reviewKind);
        // The moment the conclusion was recorded, which is what orders it against the rounds that follow it.
        expect(typeof record.recordedAt).toBe('string');
    });

    it('hands a follow-up the findings it must close, and refuses a result that answers none of them', async () => {
        const first = await prepareLedger();
        // A round that found problems, and the repair sealed on top of it: the state a follow-up exists for.
        await writeFile(reviewRoundsPath(root, changeId), `${JSON.stringify({
            at: '2026-01-01T00:00:00.000Z',
            revisionId: first.revision,
            manifestHash: first.manifestHash,
            kind: 'certification',
            blockingIds: ['F-1'],
            blockingCount: 1,
            findings: [{ id: 'F-1', severity: 'major', class: 'instrument-unsound', origin: 'original' }],
        })}\n`);
        const second = await sealWithRecord('export const holds = false;\n', first.revision);
        // The subject has to describe the repaired content, or the builder refuses to brief anyone on content that has moved —
        // its own guard, and the reason this is a re-freeze rather than a fixture detail.
        const refrozen = await freezeSubject({ root, paths: ['src/a.ts'] });
        if (!refrozen.ok) throw new Error(refrozen.error);
        await writeSubject(root, changeId, refrozen.subject);

        const run = await ledger(['run', '--out', 'tmp/followup.json']);
        expect(run.ok, JSON.stringify(run)).toBe(true);
        const brief = run.request as {
            requestId: string;
            reviewKind: string;
            repairBatch?: { roundAt: string; findings: Array<{ id: string }>; scope: string[]; unmodifiedPaths?: string[] };
        };
        // **The object the word was missing.** Which round, which findings, which chain — and what this round does not have
        // to re-open, derived from the two revisions' own digests rather than asked of the operator.
        expect(brief.reviewKind).toBe('focused_followup');
        expect(brief.repairBatch?.findings.map((finding) => finding.id)).toEqual(['F-1']);
        expect(brief.repairBatch?.scope).toEqual([first.revision, second.id]);
        // `src/a.ts` is the declared path and the repair changed it, so nothing is exempt from this round.
        expect(brief.repairBatch?.unmodifiedPaths).toEqual([]);

        await inReview();
        const finding = { id: 'R-1', taskId: changeId, severity: 'minor', message: 'a detail' };
        await writeFile(join(root, 'tmp', 'unanswered.json'), `${JSON.stringify({ requestId: brief.requestId, reviewKind: brief.reviewKind, findings: [finding] })}\n`);
        const unanswered = await runCommand('review', changeId, root, { reviewResultFile: 'tmp/unanswered.json' });
        expect(unanswered.success).toBe(false);
        expect(unanswered.error).toContain('F-1');
        expect(unanswered.error).toContain('batchClosure');

        // A verdict that is neither closed nor open is refused by name rather than filed next to one that is.
        await writeFile(join(root, 'tmp', 'bad-verdict.json'), `${JSON.stringify({
            requestId: brief.requestId,
            reviewKind: brief.reviewKind,
            findings: [finding],
            batchClosure: [{ findingId: 'F-1', verdict: 'probably' }],
        })}\n`);
        const badVerdict = await runCommand('review', changeId, root, { reviewResultFile: 'tmp/bad-verdict.json' });
        expect(badVerdict.success).toBe(false);
        expect(badVerdict.error).toContain('probably');

        await writeFile(join(root, 'tmp', 'closed.json'), `${JSON.stringify({
            requestId: brief.requestId,
            reviewKind: brief.reviewKind,
            findings: [finding],
            batchClosure: [{ findingId: 'F-1', verdict: 'closed', evidence: 'the class is decided by one derivation now' }],
        })}\n`);
        const closed = await runCommand('review', changeId, root, { reviewResultFile: 'tmp/closed.json' });
        expect(closed.success, JSON.stringify(closed)).toBe(true);
        const record = JSON.parse(await readFile(reviewPath(root, changeId), 'utf8')) as { batchClosure?: unknown };
        // The answer travels on the record: a batch closure that lived only in the transcript would be the same "recorded
        // nowhere" shape this line of work keeps removing.
        expect(record.batchClosure).toEqual([{ findingId: 'F-1', verdict: 'closed', evidence: 'the class is decided by one derivation now' }]);
    });
});
