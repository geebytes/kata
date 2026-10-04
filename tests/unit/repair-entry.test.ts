import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authorizeJudgeRepair, authorizeRepair, authorizeReviewRepair, authorizeVerifyRepair } from '../../src/workflow/repair-entry.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { ledgerVerdict } from '../../src/store/verdict.js';

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

    /**
     * A revision whose manifest hash no longer matches the workspace — the drift the two copies disagreed on.
     *
     * **Sealed through the engine, not hand-written.** This helper used to write a well-formed `current-revision.json`
     * with a fabricated `manifestHash`, which is the one artefact a fixture may not decide for itself: the value under test
     * is the *identity*, so a case that invents it is measuring its own arithmetic. It is also why this file was the live
     * instance the fixture guard found while the guard's first version reported none. The seal below is real, and the drift
     * is produced the way drift happens — by changing the owned file afterwards.
     */
    async function seedSupersededRevision(root: string): Promise<{ id: string; manifestHash: string }> {
        await writeFile(join(root, 'subject.ts'), 'export const version = 1;\n', 'utf8');
        await writeJson(root, `.kata/tasks/${taskId}/task.json`, {
            id: taskId, title: 'Repair entry', phase: 'review', acceptance: [{ id: 'AC-1', statement: 'x' }],
            ownedPaths: ['subject.ts'],
            createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z',
        });
        const sealed = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: ['test'] });
        // Drift: the owned file moves after the seal, so `revisionStatus` reports `superseded` for the real reason it does.
        await writeFile(join(root, 'subject.ts'), 'export const version = 2;\n', 'utf8');
        return { id: sealed.revision.id, manifestHash: sealed.revision.manifestHash };
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
            expect((await authorizeReviewRepair(root, taskId)).denial).toMatch(/a problem the standard ladder blocks on \(blocking\)/);
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
/**
 * **A ledger deficit is a repair the router asks for, and the authoriser used to refuse it.**
 *
 * Measured on a real task: `ledger decide` answered `insufficient` with `challenge_open`, `navigation` therefore
 * routed to `/kata-build`, and `build` refused with the sentence this file writes — "Build cannot run from hardVerify
 * without a repairable verify FAIL result" — while verify was PASS. The remedy the router names could not be
 * executed by the command it named, so the only way to answer a recorded counterexample was to edit around the
 * phase guard. These cases pin the missing authorisation, and pin that it stays narrow: no ledger, a passing ledger
 * and an unreadable ledger all keep refusing.
 */
describe('a hardVerify task whose ledger has author-actionable deficits may re-enter implement', () => {
    const roots: string[] = [];
    const taskId = 'ledger-deficit-task';

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function tempRoot(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-ledger-repair-entry-'));
        roots.push(root);
        await mkdir(join(root, '.kata/tasks', taskId), { recursive: true });
        return root;
    }

    async function writeJson(root: string, relative: string, value: unknown): Promise<void> {
        await writeFile(join(root, relative), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    }

    /** A verify PASS with a decision on record: the state the refusal was measured in. */
    async function seedPassingVerify(root: string): Promise<void> {
        await writeJson(root, `.kata/tasks/${taskId}/verify.json`, {
            taskId,
            result: 'PASS',
            diffHash: 'd'.repeat(64),
            acceptance: [{ id: 'AC-1', result: 'PASS' }],
        });
    }

    /**
     * A ledger with one claim whose evidence is supported and an optional open counterexample.
     *
     * Written through the ledger's own commands rather than by hand: the value under test is *what the ledger
     * decides*, so a fixture that invented `claims.json` would be measuring its own arithmetic — the mistake this
     * repository has a fixture guard for.
     */
    async function seedLedger(root: string, withOpenChallenge: boolean): Promise<void> {
        const ledger = (argv: string[]) => runLedgerCommand(argv, { root, changeId: taskId });
        await writeFile(join(root, 'subject.ts'), 'export const holds = true;\n', 'utf8');
        await writeJson(root, `.kata/tasks/${taskId}/task.json`, { id: taskId, ownedPaths: ['subject.ts'] });
        await ledger(['freeze']);
        await ledger(['claim', 'add', '--statement', 'The export is present', '--risk-class', 'consistency',
            '--severity', 'major', '--evidence', 'E1', '--depends-on', 'path:subject.ts', '--id', 'C1']);
        const submission = join(root, 'submission.json');
        await writeFile(submission, `${JSON.stringify({
            claims: [],
            evidence: [{ id: 'E1', type: 'static_witness', ref: 'subject.ts', assertion: 'contains:holds' }],
        }, null, 2)}\n`, 'utf8');
        await ledger(['evidence', 'add', '--file', submission]);
        await ledger(['evidence', 'verify']);
        if (withOpenChallenge) {
            // The command measures a file nobody wrote, so it fails: the challenge reproduces and stays open, which is
            // the `challenge_open` deficit the router asks the author to repair.
            await ledger(['challenge', 'add', '--claim', 'C1', '--command', 'grep -q marker notes/absent.txt', '--id', 'X1']);
            await ledger(['challenge', 'check']);
        }
    }

    /** The ledger's own decision, so the case asserts against the same verdict the router reads. */
    async function ledgerVerdictOf(root: string): Promise<string> {
        return (await ledgerVerdict({ root, changeId: taskId })).kind === 'decided'
            ? (await ledgerVerdict({ root, changeId: taskId }) as { decision: { verdict: string } }).decision.verdict
            : 'not-decided';
    }

    it('authorises the re-entry when the ledger records an open counterexample', async () => {
        const root = await tempRoot();
        await seedPassingVerify(root);
        await seedLedger(root, true);

        // The precondition is the router's own: the ledger asks the author for something and cannot pass.
        expect(await ledgerVerdictOf(root)).toBe('insufficient');

        const authorization = await authorizeVerifyRepair(root, taskId);

        expect(authorization.authorized).toBe(true);
        expect(authorization.repair).toMatchObject({ fromPhase: 'hardVerify', reason: 'ledger_deficits' });
    });

    // **The no-verify entry asks a ledger too, and it used to throw the answer away.** `authorizeVerifyRepair` returned
    // `repair: null` and said nothing else, so the admission's reason was computed and discarded: a task whose ledger
    // was unreadable entered by the same silent route as a task with no ledger at all. An independent review measured
    // exactly that gap. The entry stays authorised — the state-transition route below pins it — but it now carries the
    // admission's own reason so the caller can say which record it could not repair against.
    it('carries the shared admission reason when no verify verdict exists and the ledger cannot authorise', async () => {
        const root = await tempRoot();
        await seedLedger(root, false);

        // An unreadable ledger is the state that used to be indistinguishable from an absent one: the admission refuses
        // both, and this branch discarded the refusal's reason. Corrupting the claims document is how a ledger becomes
        // unreadable in the field, so that is what the fixture does rather than inventing a verdict.
        await writeFile(join(root, '.kata/tasks', taskId, 'review', 'claims.json'), '{ not json', 'utf8');

        const authorization = await authorizeVerifyRepair(root, taskId);

        expect(authorization.authorized).toBe(true);
        expect(authorization.repair).toBeNull();
        expect(authorization.denial).toMatch(/ledger/i);
    });

    it('keeps refusing the re-entry when there is no ledger to repair', async () => {
        const root = await tempRoot();
        await seedPassingVerify(root);

        // No ledger at all: there is no recorded deficit, so nothing authorises leaving hardVerify.
        const authorization = await authorizeVerifyRepair(root, taskId);
        expect(authorization.authorized).toBe(false);
        expect(authorization.denial).toMatch(/ledger/i);
    });
});



describe('a superseded seal authorises the re-seal from hardVerify', () => {
    it('authorises the re-entry once the workspace has moved past the sealed revision', async () => {
        // Measured cost of not allowing this: a verify run known to FAIL, purely to have the phase moved back, on
        // every re-seal after a code change.
        const root = await tempRoot();
        await seedSupersededRevision(root);
        await writeJson(root, `.kata/tasks/${taskId}/verify.json`, {
            taskId,
            result: 'FAIL',
            diffHash: 'b'.repeat(64),
            acceptance: [{ id: 'AC-1', result: 'FAIL', repairScope: 'missing_test_evidence' }],
        });

        const authorization = await authorizeVerifyRepair(root, taskId);

        expect(authorization).toMatchObject({ authorized: true, entryPhase: 'hardVerify' });
        expect(authorization.repair).toMatchObject({ reason: 'revision_superseded', scopes: [] });
    });

    it('refuses a non-repairable verdict while the seal still matches, and names the remedy', async () => {
        const root = await tempRoot();
        // No current revision at all: the seal matches trivially, so drift cannot authorise anything — and a PASS is
        // not something a re-entry can repair.
        await writeJson(root, `.kata/tasks/${taskId}/verify.json`, {
            taskId,
            result: 'PASS',
            diffHash: 'b'.repeat(64),
            acceptance: [{ id: 'AC-1', result: 'PASS' }],
        });

        const authorization = await authorizeVerifyRepair(root, taskId);

        expect(authorization.authorized).toBe(false);
        expect(authorization.denial).toContain('kata-cli verify --change <task>');
        // `rba7-a4e3edc4`: the denial used to end "the sealed revision still matches the workspace", a claim about the working
        // tree that the check behind it — a hash over the revision's declared owned paths — cannot make. The wording here is the
        // falsifier: restoring the workspace claim reddens it.
        expect(authorization.denial).not.toMatch(/matches the workspace/);
        expect(authorization.denial).toMatch(/declared/i);
    });
});
});