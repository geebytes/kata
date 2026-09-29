import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendClaim, freezeSubject, readLedger, writeSubject } from '../../src/store/ledger.js';
import { ledgerVerdict, openLedgerProblems } from '../../src/store/verdict.js';
import { makeClaim } from '../helpers/review.js';

/**
 * **The summary's read is the read, and the router's answer cannot depend on which read failed.**
 *
 * `readUpstreamSummary` reads `current-revision.json` to know what content a verdict is about; `readReviewRecord` reads
 * the same file again to bind the recorded review to it. When the second read was the one that failed, the router
 * reported `unreadable_review_record` (priority 1150) and routed to `/kata-review`, **bypassing the branch written for
 * exactly that state** — so the operator was sent to re-read a review whose premise could not be read at all.
 *
 * The pointer is written non-atomically, so "read it twice and hope" is not a guard. The count is asserted here, because
 * that is what makes the answer invariant: one decision, one read, whatever the file does next.
 */
const revisionReads = vi.hoisted(() => ({ count: 0, failFrom: Number.POSITIVE_INFINITY }));
vi.mock('../../src/workflow/revision.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../../src/workflow/revision.js')>();
    return {
        ...original,
        readCurrentTaskRevisionState: async (...args: Parameters<typeof original.readCurrentTaskRevisionState>) => {
            revisionReads.count += 1;
            if (revisionReads.count >= revisionReads.failFrom) {
                return { kind: 'unreadable', detail: 'the pointer could not be read on this attempt' } as never;
            }
            return original.readCurrentTaskRevisionState(...args);
        },
    };
});

const { readUpstreamSummary } = await import('../../src/workflow/navigation.js');
const { suggestCandidateAction } = await import('../../src/workflow/navigation.js');
const { createTaskRevisionIfChanged } = await import('../../src/workflow/revision.js');

const NOW = '2026-09-29T00:00:00.000Z';
let root: string;
const taskId = 'summary-read';

async function seed(): Promise<void> {
    root = await mkdtemp(join(tmpdir(), 'kata-summary-'));
    await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
    await writeFile(join(root, 'subject.ts'), 'export const version = 1;\n');
    await writeFile(
        join(root, '.kata', 'tasks', taskId, 'task.json'),
        `${JSON.stringify({ id: taskId, title: 'T', phase: 'review', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['subject.ts'], createdAt: NOW, updatedAt: NOW })}\n`,
    );
    await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: [] });
    const sealed = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, '.kata', 'tasks', taskId, 'current-revision.json'), 'utf8'));
    await writeFile(
        join(root, '.kata', 'tasks', taskId, 'review.json'),
        `${JSON.stringify({ revisionId: sealed.id, manifestHash: sealed.manifestHash, status: 'pending', reviewEvidence: 'reviewed', findings: [] })}\n`,
    );
    await writeFile(
        join(root, '.kata', 'tasks', taskId, 'current-state.json'),
        `${JSON.stringify({ taskId, phase: 'review', actor: { id: 'kata-reviewer', role: 'reviewer' }, updatedAt: NOW })}\n`,
    );
}

describe('the summary carries its own read into the review reader', () => {
    beforeEach(async () => {
        await seed();
        revisionReads.count = 0;
        revisionReads.failFrom = Number.POSITIVE_INFINITY;
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('reads the current revision once for a whole router decision', async () => {
        const upstream = await readUpstreamSummary(root, taskId);
        suggestCandidateAction('review', upstream);
        // One. The summary used to read it, the review reader used to read it again, and the two could disagree.
        expect(revisionReads.count).toBe(1);
    });

    it('gives the same answer whether or not a later read of the same file would have failed', async () => {
        const clean = suggestCandidateAction('review', await readUpstreamSummary(root, taskId));

        revisionReads.count = 0;
        // Every read after the first fails, which is the state that used to be reported as an unreadable review record.
        revisionReads.failFrom = 2;
        const upstream = await readUpstreamSummary(root, taskId);
        const second = suggestCandidateAction('review', upstream);

        expect(second.reason).toBe(clean.reason);
        expect(second.reason).not.toBe('unreadable_review_record');
    });
});

describe('the summary hands its ledger read to every reader that needs one', () => {
    it('uses the ledger it was given rather than opening the files again', async () => {
        // **The mechanism, asserted where it can be observed.** An independent reading measured the count directly (by
        // wrapping `readFile`: ten ledger files, each opened twice per summary, so `claims.json:2 evidence.json:2 …`). A
        // count is not reproducible here without mocking a core module, so this asserts the property the count stands for:
        // a reader handed a ledger answers from **that** ledger. A reader that re-opened the files would answer from disk,
        // and the two differ in this fixture.
        // The outer `beforeEach` already made a fresh temp root for this case; reuse it rather than adding a second
        // cleanup path.
        const changeId = 'handed-ledger';
        await mkdir(join(root, '.kata', 'tasks', changeId, 'review'), { recursive: true });
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src', 'a.ts'), 'holds\n', 'utf8');
        await writeFile(
            join(root, '.kata', 'tasks', changeId, 'task.json'),
            `${JSON.stringify({ id: changeId, ownedPaths: ['src/a.ts'], workflowProfile: { reviewMode: 'strict' } }, null, 2)}\n`,
        );
        const subject = await freezeSubject({ root, paths: ['src/a.ts'] });
        if (!subject.ok) throw new Error(subject.error);
        await writeSubject(root, changeId, subject.subject);
        // On disk: one claim, with no evidence, so the ledger decides `insufficient` over one claim.
        await appendClaim(root, changeId, makeClaim({ id: 'ON-DISK', severity: 'major', evidenceIds: [], dependsOn: ['path:src/a.ts'] }));

        const onDisk = await readLedger(root, changeId);
        const handed: typeof onDisk = {
            ...onDisk,
            claims: [makeClaim({ id: 'HANDED', severity: 'major', evidenceIds: [], dependsOn: ['path:src/a.ts'] })],
        };

        const verdict = await ledgerVerdict({ root, changeId, ledger: handed });
        expect(verdict.kind).toBe('decided');
        if (verdict.kind !== 'decided') return;
        // The claim the decision is about is the one that came in the handed read, which is the whole point.
        expect(verdict.decision.deficits.map((deficit) => deficit.claimId)).toContain('HANDED');
        expect(verdict.decision.deficits.map((deficit) => deficit.claimId)).not.toContain('ON-DISK');

        const problems = await openLedgerProblems(root, changeId, handed);
        expect(problems.kind).toBe('read');
        if (problems.kind !== 'read') return;
        expect(problems.problems.map((problem) => problem.id)).toEqual(['HANDED']);
    });
});
