import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout, taskPath } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { mutateTaskArtefact } from '../../src/core/state.js';
import { createTaskRevision } from '../../src/workflow/revision.js';
import { computeDiffHash } from '../../src/quality/evidence.js';
import { evaluateDistillGates, evaluateReviewClearance, freshPassingTestEvidence, assertDistillGates } from '../../src/workflow/distill-gates.js';

/**
 * The distill gate used to decide all three conditions itself, from a single projection file
 * (`.kata/evidence/<taskId>-hard.json`) rather than from the evidence the task recorded, and re-derived the Judge's
 * validity rules a third time. These tests pin the rules the gate now asks, including the two the projection hid: the
 * gate sees the whole recorded set, and a Judge PASS counts only when it accepted that evidence.
 */
describe('distill gates', () => {
    const roots: string[] = [];
    const taskId = 'gate-task';

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function tempRoot(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-distill-gate-'));
        roots.push(root);
        await mkdir(join(root, '.kata/tasks', taskId), { recursive: true });
        await mkdir(join(root, '.kata/evidence'), { recursive: true });
        return root;
    }

    async function recordEvidence(root: string, file: string, overrides: Record<string, unknown> = {}): Promise<void> {
        const diffHash = await computeDiffHash(root);
        await writeFile(join(root, '.kata/evidence', file), `${JSON.stringify({
            id: 'evidence-1',
            taskId,
            kind: 'test',
            command: 'npm test',
            exitCode: 0,
            startedAt: '2026-09-17T00:00:00.000Z',
            finishedAt: '2026-09-17T00:00:01.000Z',
            diffHash,
            ...overrides,
        })}\n`, 'utf8');
    }

    async function writeReview(root: string, review: Record<string, unknown>): Promise<void> {
        await writeFile(join(root, '.kata/tasks', taskId, 'review.json'), `${JSON.stringify({ findings: [], status: 'approved', ...review })}\n`, 'utf8');
    }

    async function writeJudge(root: string, judge: Record<string, unknown>): Promise<void> {
        const diffHash = await computeDiffHash(root);
        await writeFile(join(root, '.kata/tasks', taskId, 'judge.json'), `${JSON.stringify({
            taskId,
            result: 'PASS',
            diffHash,
            acceptance: [{ id: 'AC-1', result: 'PASS', evidenceIds: ['evidence-1'] }],
            ...judge,
        })}\n`, 'utf8');
    }

    it('passes when the recorded evidence, the review and the Judge pass all agree', async () => {
        const root = await tempRoot();
        await recordEvidence(root, `${taskId}-test.json`);
        await writeReview(root, { reviewEvidence: 'Reviewed against the sealed revision.' });
        await writeJudge(root, {});

        const report = await evaluateDistillGates(root, taskId);

        expect(report.freshEvidence?.evidence.id).toBe('evidence-1');
        expect(report.review).toMatchObject({ cleared: true });
        expect(report.judge).toMatchObject({ passed: true });
        await expect(assertDistillGates(root, taskId)).resolves.toBeUndefined();
    });

    it('reads the recorded set rather than one known filename', async () => {
        const root = await tempRoot();
        // Two envelopes of the same kind, the failing one first: a reader of a single projection file would stop here.
        await recordEvidence(root, `${taskId}-failed.json`, { id: 'evidence-failed', exitCode: 1 });
        await recordEvidence(root, `${taskId}-test.json`);
        await writeReview(root, { reviewEvidence: 'Reviewed.' });
        await writeJudge(root, {});

        const report = await evaluateDistillGates(root, taskId);

        expect(report.freshEvidence?.evidence.id).toBe('evidence-1');
        await expect(assertDistillGates(root, taskId)).resolves.toBeUndefined();
    });

    it('ignores evidence recorded for another task', async () => {
        const root = await tempRoot();
        await recordEvidence(root, `${taskId}-foreign.json`, { id: 'foreign', taskId: `${taskId}-other` });
        await writeReview(root, { reviewEvidence: 'Reviewed.' });
        await writeJudge(root, {});

        const report = await evaluateDistillGates(root, taskId);

        expect(report.freshEvidence).toBeNull();
        await expect(assertDistillGates(root, taskId)).rejects.toThrow(/fresh evidence, reviewer clearance, and judge PASS/);
    });

    it('blocks an approval that carries no review evidence', async () => {
        const root = await tempRoot();
        await recordEvidence(root, `${taskId}-test.json`);
        await writeReview(root, {});
        await writeJudge(root, {});

        const report = await evaluateDistillGates(root, taskId);

        expect(report.review).toMatchObject({ cleared: false, reason: 'no_review_evidence' });
        await expect(assertDistillGates(root, taskId)).rejects.toThrow(/fresh evidence, reviewer clearance, and judge PASS/);
    });

    it('blocks a review with blocking findings, and one bound to another revision', async () => {
        const root = await tempRoot();
        await recordEvidence(root, `${taskId}-test.json`);
        await writeJudge(root, {});

        await writeReview(root, {
            reviewEvidence: 'Reviewed.',
            findings: [{ id: 'F-1', taskId, severity: 'blocking', message: 'Blocked.' }],
        });
        expect((await evaluateDistillGates(root, taskId)).review).toMatchObject({ cleared: false, reason: 'blocking_findings' });

        // A review bound to an older revision is stale for the revision the gate is sealing. Evidence without a
        // revision binding (legacy repository-scoped evidence) has nothing to compare, so the rule is asked directly.
        await writeReview(root, { reviewEvidence: 'Reviewed.', revisionId: 'revision-old' });
        expect(await evaluateReviewClearance(root, taskId, 'revision-current')).toMatchObject({ cleared: false, reason: 'stale_review' });
        expect(await evaluateReviewClearance(root, taskId, 'revision-old')).toMatchObject({ cleared: true });
    });

    it('blocks a Judge PASS that did not accept the evidence the gate is reading', async () => {
        const root = await tempRoot();
        await recordEvidence(root, `${taskId}-test.json`);
        await writeReview(root, { reviewEvidence: 'Reviewed.' });
        await writeJudge(root, { acceptance: [{ id: 'AC-1', result: 'PASS', evidenceIds: ['evidence-other'] }], evidenceIds: ['evidence-other'] });

        const report = await evaluateDistillGates(root, taskId);

        expect(report.judge).toMatchObject({ passed: false, reason: 'evidence_not_accepted' });
    });

    it('blocks a Judge PASS recorded against a different diff', async () => {
        const root = await tempRoot();
        await recordEvidence(root, `${taskId}-test.json`);
        await writeReview(root, { reviewEvidence: 'Reviewed.' });
        await writeJudge(root, { diffHash: 'f'.repeat(64) });

        expect((await evaluateDistillGates(root, taskId)).judge).toMatchObject({ passed: false, reason: 'stale_judgement' });
    });

    it('blocks a Judge FAIL and a failing acceptance criterion', async () => {
        const root = await tempRoot();
        await recordEvidence(root, `${taskId}-test.json`);
        await writeReview(root, { reviewEvidence: 'Reviewed.' });

        await writeJudge(root, { result: 'FAIL' });
        expect((await evaluateDistillGates(root, taskId)).judge).toMatchObject({ passed: false, reason: 'not_passed' });

        await writeJudge(root, { acceptance: [{ id: 'AC-1', result: 'FAIL', repairScope: 'failing_evidence' }] });
        expect((await evaluateDistillGates(root, taskId)).judge).toMatchObject({ passed: false, reason: 'failing_acceptance' });
    });

    it('drops evidence bound to a revision whose task declaration has since moved', async () => {
        // `rba7-f3`: the `declaration-moved` branch in `freshPassingTestEvidence` had no case that entered it — the only
        // evidence-binding fixture corrected the task declaration to equal the revision's first, so the call was ever only
        // exercised in the `current` direction and deleting the branch left the suite green. A guard whose removal leaves the
        // suite green is decorative by this change's own rule, so this is that branch's case: seal a revision, bind passing
        // evidence to it, then grow the task's declaration without touching the owned content.
        const root = await mkdtemp(join(tmpdir(), 'kata-distill-gate-'));
        roots.push(root);
        await initLayout(root);
        await mkdir(join(root, 'src'), { recursive: true });
        await writeFile(join(root, 'src', 'owned.ts'), 'sealed\n', 'utf8');
        await createTask({ root, id: taskId, title: 'Gate', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['src/owned.ts'] });
        const revision = await createTaskRevision({ root, taskId, ownedPaths: ['src/owned.ts'] });
        // Passing test evidence **bound to that revision**, which is the envelope the branch exists to judge.
        await recordEvidence(root, `${taskId}-test.json`, { id: 'bound-evidence', revisionId: revision.id });
        const diffHash = await computeDiffHash(root);

        // Before the declaration moves, the evidence is the fresh evidence the gate is looking for.
        expect((await freshPassingTestEvidence(root, taskId, diffHash))?.evidence.id).toBe('bound-evidence');

        // The declaration grows and no owned file changes: exactly the shape `declaration-moved` names.
        await mutateTaskArtefact(root, taskId, taskPath(root, taskId), async (raw) => {
            const current = JSON.parse(raw) as Record<string, unknown>;
            return `${JSON.stringify({ ...current, ownedPaths: ['src/owned.ts', 'src/added.ts'] }, null, 2)}\n`;
        });

        // The revision is no longer current, so the evidence cannot be what an archive rests on. Removing the branch makes
        // this return the bound evidence and reddens the assertion.
        expect(await freshPassingTestEvidence(root, taskId, diffHash)).toBeNull();
    });
});
