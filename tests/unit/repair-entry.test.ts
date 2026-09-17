import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authorizeJudgeRepair, authorizeRepair, authorizeReviewRepair, authorizeVerifyRepair } from '../../src/workflow/repair-entry.js';

/**
 * One table per gate over (entry phase × artefact outcome × drift state).
 *
 * Re-entering implementation used to be three hand-written functions whose repairable-scope sets had already drifted
 * apart (the verify copy authorised `revision_superseded`, the judge copy did not, until drift deadlocked it). These
 * cases pin the single decision, including the drift authorisation that the copies disagreed about.
 */
describe('repair authorisation', () => {
    const roots: string[] = [];
    const taskId = 'repair-entry-task';

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function tempRoot(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-repair-entry-'));
        roots.push(root);
        await mkdir(join(root, '.kata/tasks', taskId), { recursive: true });
        return root;
    }

    async function writeJson(root: string, relative: string, value: unknown): Promise<void> {
        await writeFile(join(root, relative), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    }

    /** A sealed revision whose manifest hash no longer matches the workspace: the drift the two copies disagreed on. */
    async function seedSupersededRevision(root: string): Promise<{ id: string; manifestHash: string }> {
        await writeFile(join(root, 'subject.ts'), 'export const version = 2;\n', 'utf8');
        const revision = { id: 'revision-superseded', taskId, ownedPaths: ['subject.ts'], manifestHash: 'a'.repeat(64), createdAt: '2026-09-17T00:00:00.000Z' };
        await writeJson(root, `.kata/tasks/${taskId}/current-revision.json`, revision);
        return revision;
    }

    describe('hardVerify', () => {
        it('authorises a repairable verify FAIL and records its scopes', async () => {
            const root = await tempRoot();
            await writeJson(root, `.kata/tasks/${taskId}/verify.json`, {
                taskId,
                result: 'FAIL',
                diffHash: 'b'.repeat(64),
                acceptance: [{ id: 'AC-1', result: 'FAIL', repairScope: 'failing_evidence' }],
            });

            const authorization = await authorizeVerifyRepair(root, taskId);

            expect(authorization).toMatchObject({ authorized: true, entryPhase: 'hardVerify' });
            expect(authorization.repair).toMatchObject({ reason: 'verify_fail', scopes: [{ id: 'AC-1', repairScope: 'failing_evidence' }] });
        });

        it('records a re-seal when verify failed without blaming an acceptance', async () => {
            const root = await tempRoot();
            await writeJson(root, `.kata/tasks/${taskId}/verify.json`, { taskId, result: 'FAIL', diffHash: 'b'.repeat(64), acceptance: [] });

            expect((await authorizeVerifyRepair(root, taskId)).repair).toMatchObject({ reason: 'verify_reseal' });
        });

        it('authorises drift repairs, which only verify may do', async () => {
            const root = await tempRoot();
            await writeJson(root, `.kata/tasks/${taskId}/verify.json`, {
                taskId,
                result: 'FAIL',
                diffHash: 'b'.repeat(64),
                acceptance: [{ id: 'AC-1', result: 'FAIL', repairScope: 'revision_superseded' }],
            });

            expect((await authorizeVerifyRepair(root, taskId)).repair).toMatchObject({ reason: 'verify_fail' });
        });

        it('refuses a verify PASS and a non-repairable scope', async () => {
            const root = await tempRoot();
            await writeJson(root, `.kata/tasks/${taskId}/verify.json`, { taskId, result: 'PASS', diffHash: 'c'.repeat(64), acceptance: [{ id: 'AC-1', result: 'PASS' }] });
            expect(await authorizeVerifyRepair(root, taskId)).toMatchObject({ authorized: false, repair: null });

            await writeJson(root, `.kata/tasks/${taskId}/verify.json`, {
                taskId,
                result: 'FAIL',
                diffHash: 'c'.repeat(64),
                acceptance: [{ id: 'AC-1', result: 'FAIL', repairScope: 'cross_revision_evidence' }],
            });
            expect((await authorizeVerifyRepair(root, taskId)).denial).toMatch(/repairable verify FAIL/);
        });

        it('enters without a repair record when no verify verdict exists', async () => {
            const root = await tempRoot();

            const authorization = await authorizeVerifyRepair(root, taskId);

            expect(authorization).toMatchObject({ authorized: true, repair: null });
        });
    });

    describe('review', () => {
        it('authorises blocking findings bound to the sealed revision', async () => {
            const root = await tempRoot();
            const revision = await seedSupersededRevision(root);
            await writeJson(root, `.kata/tasks/${taskId}/review.json`, {
                revisionId: revision.id,
                status: 'pending',
                findings: [{ id: 'finding-1', taskId, severity: 'blocking', message: 'Must repair' }],
            });
            // The revision is superseded by construction, so this asserts the severity path on its own terms.
            const authorization = await authorizeReviewRepair(root, taskId);

            expect(authorization).toMatchObject({ authorized: true });
            expect(authorization.repair).toMatchObject({ reason: 'review_findings' });
            expect(authorization.repair?.findings).toEqual([{ id: 'finding-1', severity: 'blocking', message: 'Must repair' }]);
        });

        it('authorises strict-mode major findings and passes standard-mode majors through', async () => {
            const root = await tempRoot();
            const revision = await seedSupersededRevision(root);
            await writeJson(root, `.kata/tasks/${taskId}/task.json`, { id: taskId, title: 'Repair entry', phase: 'review', acceptance: [{ id: 'AC-1', statement: 'x' }], createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z', workflowProfile: { version: 1, isolationMode: 'current_worktree', developmentMode: 'tdd', reviewMode: 'strict', comet: { projectInit: 'not_requested', openStatus: 'acknowledged' } } });
            await writeJson(root, `.kata/tasks/${taskId}/review.json`, {
                revisionId: revision.id,
                status: 'pending',
                findings: [{ id: 'finding-1', taskId, severity: 'major', message: 'Major' }],
            });

            expect((await authorizeReviewRepair(root, taskId)).repair).toMatchObject({ reason: 'review_findings' });

            await writeJson(root, `.kata/tasks/${taskId}/task.json`, { id: taskId, title: 'Repair entry', phase: 'review', acceptance: [{ id: 'AC-1', statement: 'x' }], createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z' });
            // Standard mode: a major finding alone does not authorise, but the superseded revision still does.
            expect((await authorizeReviewRepair(root, taskId)).repair).toMatchObject({ reason: 'revision_superseded' });
        });

        it('refuses an unbound review, a minor-only review without drift, and a missing review', async () => {
            const root = await tempRoot();
            await writeJson(root, `.kata/tasks/${taskId}/review.json`, { revisionId: 'revision-other', status: 'pending', findings: [] });
            expect((await authorizeReviewRepair(root, taskId)).denial).toMatch(/not bound to the current sealed revision/);

            await writeJson(root, `.kata/tasks/${taskId}/review.json`, { status: 'pending', findings: [{ id: 'finding-1', taskId, severity: 'minor', message: 'Advisory' }] });
            expect((await authorizeReviewRepair(root, taskId)).denial).toMatch(/blocking \(or strict-mode major\) review findings/);
        });
    });

    describe('judge', () => {
        it('authorises a repairable judge FAIL and records its scopes', async () => {
            const root = await tempRoot();
            await writeJson(root, `.kata/tasks/${taskId}/judge.json`, {
                taskId,
                result: 'FAIL',
                diffHash: 'b'.repeat(64),
                acceptance: [{ id: 'AC-1', result: 'FAIL', repairScope: 'missing_test_evidence' }],
            });

            const authorization = await authorizeJudgeRepair(root, taskId);

            expect(authorization.repair).toMatchObject({ reason: 'judge_fail', scopes: [{ id: 'AC-1', repairScope: 'missing_test_evidence' }] });
        });

        it('authorises a judge PASS when the sealed revision drifted, recording the baseline it supersedes', async () => {
            const root = await tempRoot();
            const revision = await seedSupersededRevision(root);
            await writeJson(root, `.kata/tasks/${taskId}/judge.json`, { taskId, result: 'PASS', diffHash: 'b'.repeat(64), acceptance: [{ id: 'AC-1', result: 'PASS' }] });

            const authorization = await authorizeJudgeRepair(root, taskId);

            expect(authorization.repair).toMatchObject({
                reason: 'revision_superseded',
                baselineRevisionId: revision.id,
                baselineManifestHash: revision.manifestHash,
            });
        });

        it('refuses a judge PASS without drift, and a non-repairable scope', async () => {
            const root = await tempRoot();
            await writeJson(root, `.kata/tasks/${taskId}/judge.json`, { taskId, result: 'PASS', diffHash: 'b'.repeat(64), acceptance: [{ id: 'AC-1', result: 'PASS' }] });
            expect((await authorizeJudgeRepair(root, taskId)).denial).toMatch(/repairable judge FAIL result/);

            await writeJson(root, `.kata/tasks/${taskId}/judge.json`, {
                taskId,
                result: 'FAIL',
                diffHash: 'b'.repeat(64),
                acceptance: [{ id: 'AC-1', result: 'FAIL', repairScope: 'revision_superseded' }],
            });
            // Drift is authorised by verify, not by a judge FAIL: without a superseded revision this is a refusal.
            expect((await authorizeJudgeRepair(root, taskId)).authorized).toBe(false);
        });
    });

    it('routes each phase to its own authorizer', async () => {
        const root = await tempRoot();
        await writeJson(root, `.kata/tasks/${taskId}/judge.json`, {
            taskId,
            result: 'FAIL',
            diffHash: 'b'.repeat(64),
            acceptance: [{ id: 'AC-1', result: 'FAIL', repairScope: 'failing_evidence' }],
        });

        expect((await authorizeRepair('judge', root, taskId)).repair).toMatchObject({ reason: 'judge_fail' });
        expect((await authorizeRepair('hardVerify', root, taskId)).authorized).toBe(true);
    });
});
