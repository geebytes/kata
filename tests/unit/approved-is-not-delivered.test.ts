import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { runGit } from '../../src/core/git.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import {
    commitReachesTarget,
    decideCompletion,
    readCompletion,
    recordIntegration,
    recordStop,
    recordWaiver,
    type CompletionFacts,
} from '../../src/workflow/completion.js';
import { runCompletionCommand } from '../../src/cli/completion.js';
import { readUpstreamSummary } from '../../src/workflow/navigation.js';
import { createWorktree } from '../../src/workflow/worktree.js';

/**
 * **Approved is not delivered.**
 *
 * Every surface an operator reads used the same word for "a Judge passed this candidate" and "this change is in the
 * codebase": `status` printed a certified task as finished while its content sat on a branch nobody merged, and the archive
 * boundary said nothing about where the work went. The two are different facts about different objects — a *candidate* and
 * a *delivery* — and the fix is not a stricter gate but a separate, honestly named state derived from evidence.
 *
 * The record is evidence rather than a claim: the commit must be in the target's history (a SHA compared against a SHA, not
 * git's prose), and the check the operator names is *run* here with its exit code recorded. What it cannot prove is stated
 * on the module rather than implied.
 */

const roots: string[] = [];

function write(root: string, relativePath: string, content: string): void {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
}

/** A repository with one commit, so `HEAD` resolves and the integration check has something real to compare. */
async function repository(name: string): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), `kata-completion-${name}-`));
    roots.push(root);
    runGit(root, ['init', '-q']);
    write(root, 'src/a.ts', 'a v1\n');
    runGit(root, ['add', '.']);
    runGit(root, ['-c', 'user.email=kata@example.test', '-c', 'user.name=kata', 'commit', '-qm', 'init']);
    await initLayout(root);
    return root;
}

async function task(root: string, id: string, options: { certify?: boolean } = {}): Promise<string | null> {
    await createTask({
        root,
        id,
        title: id,
        acceptance: [{ id: 'AC-1', statement: 'x' }],
        ownedPaths: ['src/a.ts'],
    });
    if (!options.certify) return null;
    const { revision } = await createTaskRevisionIfChanged({ root, taskId: id, ownedPaths: ['src/a.ts'] });
    write(root, `.kata/tasks/${id}/judge.json`, `${JSON.stringify({
        taskId: id,
        result: 'PASS',
        revisionId: revision.id,
        acceptance: [{ id: 'AC-1', result: 'PASS' }],
    }, null, 2)}\n`);
    return revision.id;
}

function headCommit(root: string): string {
    return runGit(root, ['rev-parse', 'HEAD']).stdout.trim();
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const facts = (over: Partial<CompletionFacts> = {}): CompletionFacts => ({
    taskId: 'held',
    currentRevisionId: 'revision-1',
    revisionReadState: 'current',
    judgedPass: true,
    phase: 'judge',
    record: null,
    recordReadState: 'absent',
    commitInTarget: null,
    recordsHome: 'primary',
    worktreeOnlyRecords: [],
    worktreeOnlyHolders: [],
    ...over,
});

const integration = {
    target: 'master',
    commit: 'a'.repeat(40),
    certifiedRevisionId: 'revision-1',
    check: { command: 'npm', args: ['test'], exitCode: 0, at: '2026-01-01T00:00:00.000Z' },
    recordedAt: '2026-01-01T00:00:00.000Z',
};

describe('the one decision about how a task ended', () => {
    it('is uncertified without a revision, and without a Judge pass bound to the current one', () => {
        expect(decideCompletion(facts({ currentRevisionId: null, revisionReadState: 'absent' })).state).toBe('uncertified');
        expect(decideCompletion(facts({ judgedPass: false })).reason).toBe('not_judged');
        // A pointer nobody can read is named rather than reported as "no revision".
        expect(decideCompletion(facts({ revisionReadState: 'unreadable' })).reason).toBe('current_revision_unreadable');
    });

    it('is in flight — not finished — while the certified candidate has no integration', () => {
        const decision = decideCompletion(facts());
        expect(decision.state).toBe('approved_awaiting_integration');
        expect(decision.reason).toBe('integration_not_recorded');
        expect(decision.road).toMatch(/completion integrate --change held/u);
    });

    it('refuses to count an integration recorded for a different revision', () => {
        const decision = decideCompletion(facts({
            currentRevisionId: 'revision-2',
            record: { taskId: 'held', updatedAt: '', integration },
        }));
        expect(decision.state).toBe('approved_awaiting_integration');
        expect(decision.reason).toBe('integration_for_another_revision');
    });

    it('names a commit that is not in the target, and one that could not be checked, as two different things', () => {
        const notInTarget = decideCompletion(facts({ commitInTarget: false, record: { taskId: 'held', updatedAt: '', integration } }));
        expect(notInTarget.reason).toBe('commit_not_in_target');
        expect(notInTarget.state).toBe('approved_awaiting_integration');

        // "I could not look" is never reported as "it is there": an unverifiable delivery is not a delivery.
        const unverifiable = decideCompletion(facts({ commitInTarget: null, phase: 'archive', record: { taskId: 'held', updatedAt: '', integration } }));
        expect(unverifiable.reason).toBe('commit_unverifiable');
        expect(unverifiable.state).toBe('approved_awaiting_integration');
    });

    it('is integrated but unfinished until the governance transaction closes', () => {
        const decision = decideCompletion(facts({ commitInTarget: true, phase: 'judge', record: { taskId: 'held', updatedAt: '', integration } }));
        expect(decision.state).toBe('approved_awaiting_integration');
        expect(decision.reason).toBe('archive_not_reached');
        expect(decision.road).toBe('kata-cli archive --change held');
    });

    it('is delivered only when the integration names the current revision, the commit is in the target, and the task is archived', () => {
        const decision = decideCompletion(facts({ commitInTarget: true, phase: 'archive', record: { taskId: 'held', updatedAt: '', integration } }));
        expect(decision.state).toBe('delivered_and_archived');
        expect(decision.road).toBeNull();
    });

    it('lets an explicit human decision outrank everything derived, and never calls it delivered', () => {
        const stopped = decideCompletion(facts({ phase: 'archive', record: { taskId: 'held', updatedAt: '', stop: { reason: 'the approach was wrong', recordedAt: '' } } }));
        expect(stopped.state).toBe('stopped_not_delivered');
        expect(stopped.detail).toMatch(/the approach was wrong/u);

        const waived = decideCompletion(facts({ phase: 'archive', record: { taskId: 'held', updatedAt: '', waiver: { reason: 'no time', impact: 'one unreadable record stays unreadable', recordedAt: '' } } }));
        expect(waived.state).toBe('human_waived_with_gap');
        expect(waived.detail).toMatch(/one unreadable record stays unreadable/u);
    });

    it('reports a damaged completion record as damaged rather than as awaiting integration', () => {
        const decision = decideCompletion(facts({ recordReadState: 'unreadable' }));
        expect(decision.reason).toBe('completion_record_unreadable');
        expect(decision.state).toBe('uncertified');
    });
});

describe('the integration writer asks the repository, not the operator', () => {
    it('refuses a task with nothing sealed, and a task whose revision carries no Judge pass', async () => {
        const root = await repository('uncertified');
        await task(root, 'held');
        await expect(recordIntegration({
            root, taskId: 'held', target: 'HEAD', commit: headCommit(root), check: { command: 'true', args: [] },
        })).rejects.toThrow(/no readable current revision/u);

        // Sealed but not judged: still nothing that has been certified for delivery.
        const sealedRoot = await repository('sealed-unjuged');
        await task(sealedRoot, 'held', { certify: true });
        write(sealedRoot, '.kata/tasks/held/judge.json', `${JSON.stringify({ taskId: 'held', result: 'FAIL', revisionId: 'revision-other', acceptance: [{ id: 'AC-1', result: 'FAIL' }] })}\n`);
        await expect(recordIntegration({
            root: sealedRoot, taskId: 'held', target: 'HEAD', commit: headCommit(sealedRoot), check: { command: 'true', args: [] },
        })).rejects.toThrow(/no passing Judge record/u);
    });

    it('refuses a commit that is not in the target history', async () => {
        const root = await repository('not-in-target');
        await task(root, 'held', { certify: true });
        runGit(root, ['checkout', '-q', '-b', 'side']);
        write(root, 'src/a.ts', 'a v2\n');
        // **Only `src/` is staged.** `git add .` here swept the task's own records into the branch commit, and switching
        // back deleted them — the hazard this repository already knows about (`.kata/tasks/**` is not tracked), reproduced
        // in a fixture before it could be mistaken for a defect in the module.
        runGit(root, ['add', 'src']);
        runGit(root, ['-c', 'user.email=kata@example.test', '-c', 'user.name=kata', 'commit', '-qm', 'side']);
        const side = headCommit(root);
        runGit(root, ['checkout', '-q', '-']);

        await expect(recordIntegration({
            root, taskId: 'held', target: 'HEAD', commit: side, check: { command: 'true', args: [] },
        })).rejects.toThrow(/is not in the history of/u);
    });

    it('refuses a target that does not resolve here, instead of guessing that it reached it', async () => {
        const root = await repository('unknown-target');
        await task(root, 'held', { certify: true });
        await expect(recordIntegration({
            root, taskId: 'held', target: 'no-such-branch', commit: headCommit(root), check: { command: 'true', args: [] },
        })).rejects.toThrow(/does not resolve to a commit here/u);
    });

    it('runs the target check and refuses when it fails, writing nothing', async () => {
        const root = await repository('failed-check');
        await task(root, 'held', { certify: true });
        await expect(recordIntegration({
            root, taskId: 'held', target: 'HEAD', commit: headCommit(root), check: { command: 'false', args: [] },
        })).rejects.toThrow(/exited 1/u);

        // Nothing was written: an integration whose check failed is not an integration.
        const decision = await readCompletion(root, 'held');
        expect(decision.reason).toBe('integration_not_recorded');
    });

    it('records a real integration and reports the state the evidence supports', async () => {
        const root = await repository('integrated');
        await task(root, 'held', { certify: true });
        const result = await recordIntegration({
            root,
            taskId: 'held',
            target: 'HEAD',
            commit: headCommit(root),
            check: { command: 'true', args: [] },
            note: 'merged by the owner',
        });
        expect(result.record.check.exitCode).toBe(0);
        expect(result.record.target).toBe('HEAD');
        // Integrated and certified, but the task has not been archived: in flight, and it says so.
        expect(result.decision.state).toBe('approved_awaiting_integration');
        expect(result.decision.reason).toBe('archive_not_reached');

        const stored = JSON.parse(readFileSync(join(root, '.kata/tasks/held/completion.json'), 'utf8')) as { integration?: { note?: string } };
        expect(stored.integration?.note).toBe('merged by the owner');
    });

    it('refuses to overwrite a delivery with a stop or a waiver', async () => {
        const root = await repository('no-overwrite');
        await task(root, 'held', { certify: true });
        await recordIntegration({ root, taskId: 'held', target: 'HEAD', commit: headCommit(root), check: { command: 'true', args: [] } });
        await expect(recordStop({ root, taskId: 'held', reason: 'changed my mind' })).rejects.toThrow(/already carries integration evidence/u);
        await expect(recordWaiver({ root, taskId: 'held', reason: 'r', impact: 'i' })).rejects.toThrow(/already carries integration evidence/u);
    });

    it('records a stop as its own ending, with the reason it was made', async () => {
        const root = await repository('stopped');
        await task(root, 'held', { certify: true });
        const decision = await recordStop({ root, taskId: 'held', reason: 'the approach was wrong' });
        expect(decision.state).toBe('stopped_not_delivered');
    });
});

describe('the ancestor check has three answers', () => {
    it('distinguishes "in the target" from "not in the target" from "cannot tell"', async () => {
        const root = await repository('three-answers');
        const commit = headCommit(root);
        expect(commitReachesTarget(root, 'HEAD', commit)).toBe(true);
        expect(commitReachesTarget(root, 'no-such-ref', commit)).toBeNull();
        expect(commitReachesTarget(root, 'HEAD', 'b'.repeat(40))).toBe(false);
    });
});

describe('the surfaces an operator reads use one word for one fact', () => {
    it('publishes the completion state on the summary `status` prints, and on the CLI', async () => {
        const root = await repository('published');
        await task(root, 'held', { certify: true });

        const upstream = await readUpstreamSummary(root, 'held');
        expect(upstream.completion?.state).toBe('approved_awaiting_integration');
        expect(upstream.completion?.road).toMatch(/completion integrate/u);

        const cli = await runCompletionCommand(['status', '--change', 'held', '--root', root]);
        expect(cli.state).toBe('approved_awaiting_integration');
        expect(String(cli.detail)).toMatch(/in flight and not delivered/u);
    });
});

describe('a delivered task whose records live only in a worktree is not finished', () => {
    it('names the records rather than reporting the delivery as archived', () => {
        const decision = decideCompletion(facts({
            commitInTarget: true,
            phase: 'archive',
            record: { taskId: 'held', updatedAt: '', integration },
            recordsHome: 'worktree_only',
            worktreeOnlyRecords: ['tasks/held/review.json', 'tasks/held/judge.json'],
            worktreeOnlyHolders: ['.kata/worktrees/held'],
        }));
        expect(decision.state).toBe('delivered_records_elsewhere');
        expect(decision.reason).toBe('records_only_in_a_worktree');
        expect(decision.detail).toMatch(/2 governed record\(s\)/u);
        // The road is the command that actually moves them, not a suggestion to look at the task.
        expect(decision.road).toBe('kata-cli worktree recover --change held');
    });

    it('treats "could not enumerate" as not-safe rather than as safe', () => {
        const decision = decideCompletion(facts({
            commitInTarget: true,
            phase: 'archive',
            record: { taskId: 'held', updatedAt: '', integration },
            recordsHome: 'undetermined',
        }));
        expect(decision.state).toBe('delivered_records_elsewhere');
        expect(decision.reason).toBe('records_undetermined');
    });
});

describe('the record\'s own home is read from the detector the archive already trusts', () => {
    it('reports records that exist only inside a linked worktree, and the worktree holding them', async () => {
        const root = await repository('records-elsewhere');
        await task(root, 'held', { certify: true });
        runGit(root, ['add', 'src']);
        runGit(root, ['-c', 'user.email=kata@example.test', '-c', 'user.name=kata', 'commit', '-qm', 'records']);

        // The measured shape: task state written under whichever root resolved, so a linked worktree can hold the only copy.
        const worktree = await createWorktree({ root, taskId: 'held' });
        write(worktree.path, '.kata/tasks/held/review.json', `${JSON.stringify({ findings: [], status: 'pending' })}\n`);

        // Delivered — certified, integrated, archived — with the record left behind in the worktree the archive removes.
        await recordIntegration({ root, taskId: 'held', target: 'HEAD', commit: headCommit(root), check: { command: 'true', args: [] } });
        write(root, '.kata/tasks/held/current-state.json', `${JSON.stringify({
            taskId: 'held', phase: 'archive', actor: { id: 'kata-cli', role: 'distiller' }, updatedAt: new Date().toISOString(),
        }, null, 2)}\n`);

        const decision = await readCompletion(root, 'held');
        expect(decision.state).toBe('delivered_records_elsewhere');
        expect(decision.reason).toBe('records_only_in_a_worktree');
        expect(decision.road).toBe('kata-cli worktree recover --change held');

        // And the same detector the archive's removal guard asks: what would be lost if that worktree went away.
        const { uniqueCopies } = await import('../../src/core/layout.js');
        const stranded = await uniqueCopies({ root, taskId: 'held' });
        expect(stranded.length).toBeGreaterThan(0);
        expect(stranded.every((copy) => copy.worktreeRelative.includes('worktrees'))).toBe(true);

        // Recovering them is what makes the delivery claim true, and the state follows.
        const { recoverWorktreeRecords } = await import('../../src/workflow/worktree.js');
        const recovered = await recoverWorktreeRecords({ root, taskId: 'held' });
        expect(recovered.flatMap((entry) => entry.moved).length).toBeGreaterThan(0);
        expect((await readCompletion(root, 'held')).state).toBe('delivered_and_archived');

    });
});
