import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { acceptanceContractHashOf, createTask, readTask, type AcceptanceCriterion, type TaskRecord } from '../../src/core/task.js';
import { readAcceptanceAmendments } from '../../src/quality/acceptance-amendment.js';
import { runTasksCommand } from '../../src/cli/tasks.js';
import { createTaskRevisionIfChanged, readCurrentTaskRevisionState, revisionStatus } from '../../src/workflow/revision.js';

/**
 * **A certification is about a contract, and a contract can be corrected.**
 *
 * Both halves were missing. `tasks declare` writes the matrix and the upstream coverage and refuses to rewrite criteria;
 * `ledger claim restate` corrects the reviewer-facing *claim*. So a criterion that asserted something the change had
 * falsified — measured on a real change whose AC-3 named "the same predicate `cwd` already uses", true of neither of the
 * two rules the sandbox actually has — could only be corrected by editing `task.json` by hand, outside the lock, with no
 * record of who decided it or why.
 *
 * The other half is that the correction has to *cost* something. A revision freezes the contract it certified, and
 * `revisionStatus` reports `contract-moved` when the task's contract is no longer the one that was frozen, so the seal, the
 * verify pass and the judge verdict cannot keep speaking for a sentence nobody writes any more.
 */
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const profile = {
    version: 1 as const,
    isolationMode: 'current_worktree' as const,
    developmentMode: 'tdd' as const,
    reviewMode: 'strict' as const,
    comet: { projectInit: 'not_requested' as const, openStatus: 'acknowledged' as const },
};

async function workspace(id: string, acceptance: AcceptanceCriterion[]): Promise<{ root: string; task: TaskRecord }> {
    const root = await mkdtemp(join(tmpdir(), 'kata-amendment-'));
    roots.push(root);
    await initLayout(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n', 'utf8');
    await createTask({ root, id, title: 'Amended contract', acceptance, ownedPaths: ['src/a.ts'], workflowProfile: profile });
    return { root, task: await readTask(root, id) };
}

/** The seal's own call, including the contract term it supplies (`orchestrator.ts`). */
async function seal(root: string, taskId: string, withContract = true): Promise<string> {
    const task = await readTask(root, taskId);
    const sealed = await createTaskRevisionIfChanged({
        root,
        taskId,
        ownedPaths: ['src/a.ts'],
        checkIds: [],
        ...(withContract ? { acceptanceContractHash: acceptanceContractHashOf(task.acceptance, task.acceptanceMatrix) } : {}),
    });
    return sealed.revision.id;
}

async function amendFile(root: string, name: string, expectedStatement: string, statement: string): Promise<string> {
    const path = join(root, 'tmp', name);
    await mkdir(join(root, 'tmp'), { recursive: true });
    await writeFile(path, `${JSON.stringify({ expectedStatement, statement }, null, 2)}\n`, 'utf8');
    return path;
}

/** The command as an operator runs it, rooted at the fixture rather than at the repository. */
function amend(root: string, taskId: string, acceptanceId: string, file: string, reason = 'correcting it'): Promise<Record<string, unknown>> {
    return runTasksCommand(['amend-acceptance', '--change', taskId, '--id', acceptanceId, '--file', file, '--reason', reason, '--by', 'author', '--root', root]);
}

describe('an amended acceptance contract voids the certification it was sealed under', () => {
    it('records the amendment, adopts the new sentence, and reports the revision contract-moved', async () => {
        const { root, task } = await workspace('amended', [{ id: 'AC-1', statement: 'the sandbox uses the same predicate cwd uses' }]);
        const voided = await seal(root, 'amended');

        const file = await amendFile(root, 'amendment.json', 'the sandbox uses the same predicate cwd uses', 'arguments and cwd deliberately use different rules');
        const result = await amend(root, 'amended', 'AC-1', file, 'the criterion asserted a predicate the code does not have');

        expect(result).toMatchObject({
            command: 'tasks amend-acceptance',
            ok: true,
            taskId: 'amended',
            acceptanceId: 'AC-1',
            voidedRevision: voided,
            previousStatement: 'the sandbox uses the same predicate cwd uses',
            statement: 'arguments and cwd deliberately use different rules',
            record: 'acceptance-amendments.jsonl',
        });
        // The remedy is part of the result, because the void is the point: a certification of the old contract cannot
        // speak for the amended one.
        expect(result.nextAction).toMatchObject({ cliCommand: 'kata-cli build --change amended --seal' });

        // The record carries both texts, both hashes and the revision it voids — that is the whole audit.
        const log = await readAcceptanceAmendments(root, 'amended');
        expect(log.kind).toBe('usable');
        const amendments = log.kind === 'usable' ? log.amendments : [];
        expect(amendments).toHaveLength(1);
        expect(amendments[0]).toMatchObject({
            taskId: 'amended',
            acceptanceId: 'AC-1',
            previousStatement: 'the sandbox uses the same predicate cwd uses',
            statement: 'arguments and cwd deliberately use different rules',
            previousContractHash: acceptanceContractHashOf(task.acceptance, task.acceptanceMatrix),
            voidedRevision: voided,
            reason: 'the criterion asserted a predicate the code does not have',
            by: 'author',
        });
        expect(amendments[0]?.contractHash).not.toBe(amendments[0]?.previousContractHash);

        // And the task really carries it: the amendment is a write, not a note.
        expect((await readTask(root, 'amended')).acceptance[0]?.statement).toBe('arguments and cwd deliberately use different rules');

        // **The revision stops describing what it is asked about**, and it says which comparison produced that.
        const current = await readCurrentTaskRevisionState(root, 'amended');
        if (current.kind !== 'current') throw new Error('the revision should still be stored');
        expect(await revisionStatus(root, current.revision, 'amended')).toEqual({
            status: 'contract-moved',
            revisionId: voided,
            frozenContractHash: amendments[0]?.previousContractHash,
            taskContractHash: amendments[0]?.contractHash,
        });
    });

    it('appends rather than rewrites, so a second correction keeps the first one visible', async () => {
        const { root } = await workspace('twice', [{ id: 'AC-1', statement: 'first sentence' }]);
        await seal(root, 'twice');
        const first = await amendFile(root, 'one.json', 'first sentence', 'second sentence');
        const second = await amendFile(root, 'two.json', 'second sentence', 'third sentence');
        await amend(root, 'twice', 'AC-1', first, 'first correction');
        const result = await amend(root, 'twice', 'AC-1', second, 'second correction');

        expect(result.ok).toBe(true);
        const log = await readAcceptanceAmendments(root, 'twice');
        expect(log.kind === 'usable' ? log.amendments.map((entry) => [entry.previousStatement, entry.statement]) : []).toEqual([
            ['first sentence', 'second sentence'],
            ['second sentence', 'third sentence'],
        ]);
    });

    it('refuses an amendment written against a sentence that is not on disk, and writes nothing at all', async () => {
        const { root } = await workspace('stale', [{ id: 'AC-1', statement: 'what the contract says' }]);
        await seal(root, 'stale');
        const file = await amendFile(root, 'stale.json', 'what I remember it saying', 'the correction');
        const result = await amend(root, 'stale', 'AC-1', file);

        expect(result.ok).toBe(false);
        // The refusal carries the text actually on disk, so the operator can re-run deliberately rather than guess.
        expect(String(result.error)).toContain('what the contract says');
        expect(await readAcceptanceAmendments(root, 'stale')).toEqual({ kind: 'absent' });
        expect((await readTask(root, 'stale')).acceptance[0]?.statement).toBe('what the contract says');
    });

    it('refuses to amend under a revision that records no contract, because it could not notice the amendment', async () => {
        const { root } = await workspace('legacy', [{ id: 'AC-1', statement: 'an old sentence' }]);
        // A revision sealed before the field existed: the amendment would look applied while the certification survived it.
        await seal(root, 'legacy', false);
        const file = await amendFile(root, 'legacy.json', 'an old sentence', 'a corrected sentence');
        const result = await amend(root, 'legacy', 'AC-1', file);

        expect(result.ok).toBe(false);
        expect(String(result.error)).toContain('kata-cli build --seal --change legacy');
        expect(await readAcceptanceAmendments(root, 'legacy')).toEqual({ kind: 'absent' });
        expect((await readTask(root, 'legacy')).acceptance[0]?.statement).toBe('an old sentence');
    });

    it('refuses when nothing is sealed, and names the seal that would give the amendment something to void', async () => {
        const { root } = await workspace('unsealed', [{ id: 'AC-1', statement: 'unsealed sentence' }]);
        const file = await amendFile(root, 'unsealed.json', 'unsealed sentence', 'corrected sentence');
        const result = await amend(root, 'unsealed', 'AC-1', file);

        expect(result.ok).toBe(false);
        expect(String(result.error)).toContain('kata-cli build --seal --change unsealed');
    });

    it('refuses an unknown criterion and names the ones the task has', async () => {
        const { root } = await workspace('unknown', [{ id: 'AC-1', statement: 'one' }, { id: 'AC-2', statement: 'two' }]);
        await seal(root, 'unknown');
        const file = await amendFile(root, 'unknown.json', 'three', 'four');
        const result = await amend(root, 'unknown', 'AC-9', file);

        expect(result.ok).toBe(false);
        expect(String(result.error)).toContain('AC-1, AC-2');
    });

    it('refuses an amendment that would leave the contract identical', async () => {
        const { root } = await workspace('same', [{ id: 'AC-1', statement: 'the sentence' }]);
        await seal(root, 'same');
        const file = await amendFile(root, 'same.json', 'the sentence', 'the sentence');
        const result = await amend(root, 'same', 'AC-1', file, 'no-op');

        expect(result.ok).toBe(false);
        expect(String(result.error)).toContain('byte-identical');
        expect(await readAcceptanceAmendments(root, 'same')).toEqual({ kind: 'absent' });
    });

    it('refuses a criterion whose clauses are checks bound to the sentence it would rewrite', async () => {
        const { root } = await workspace('clauses', [{
            id: 'AC-1',
            statement: 'the check holds',
            claims: [{
                id: 'c1',
                statement: 'the check holds',
                check: { command: 'true', expect: { exitCode: 0 } },
            }],
        }]);
        await seal(root, 'clauses');
        const file = await amendFile(root, 'clauses.json', 'the check holds', 'something else entirely');
        const result = await amend(root, 'clauses', 'AC-1', file);

        expect(result.ok).toBe(false);
        expect(String(result.error)).toContain('c1');
        expect(await readAcceptanceAmendments(root, 'clauses')).toEqual({ kind: 'absent' });
    });

    it('refuses without a reason, because an unexplained contract change is indistinguishable from drift', async () => {
        const { root } = await workspace('reasonless', [{ id: 'AC-1', statement: 'a sentence' }]);
        await seal(root, 'reasonless');
        const file = await amendFile(root, 'reasonless.json', 'a sentence', 'another sentence');
        const result = await amend(root, 'reasonless', 'AC-1', file, '   ');

        expect(result.ok).toBe(false);
        expect(await readAcceptanceAmendments(root, 'reasonless')).toEqual({ kind: 'absent' });
    });

    it('keeps the contract inside the revision identity, so one content under two contracts is two revisions', async () => {
        const { root } = await workspace('identity', [{ id: 'AC-1', statement: 'the first contract' }]);
        const first = await seal(root, 'identity');
        const file = await amendFile(root, 'identity.json', 'the first contract', 'the second contract');
        await amend(root, 'identity', 'AC-1', file);
        const second = await seal(root, 'identity');

        // Content is byte-identical — only the contract moved — and the two must not share one identity, or the re-seal
        // would resolve to the revision that froze the old contract and `revisionStatus` would keep answering `current`.
        expect(second).not.toBe(first);
        const current = await readCurrentTaskRevisionState(root, 'identity');
        if (current.kind !== 'current') throw new Error('the re-seal should have written a pointer');
        expect(await revisionStatus(root, current.revision, 'identity')).toEqual({ status: 'current' });
    });

    it('reports a log that exists and cannot be read as unreadable rather than as no amendments', async () => {
        const { root } = await workspace('corrupt', [{ id: 'AC-1', statement: 'a sentence' }]);
        await seal(root, 'corrupt');
        await mkdir(join(root, '.kata/tasks/corrupt'), { recursive: true });
        await writeFile(join(root, '.kata/tasks/corrupt/acceptance-amendments.jsonl'), '{ not json\n', 'utf8');

        const log = await readAcceptanceAmendments(root, 'corrupt');
        expect(log.kind).toBe('unreadable');
        // And an amendment cannot be recorded on top of a history nobody can read.
        const file = await amendFile(root, 'corrupt.json', 'a sentence', 'a corrected sentence');
        const result = await amend(root, 'corrupt', 'AC-1', file);
        expect(result.ok).toBe(false);
        expect((await readTask(root, 'corrupt')).acceptance[0]?.statement).toBe('a sentence');
    });

    it('has exactly one production caller of the revision creators, and it states the contract it seals', async () => {
        // A wiring lint, and its boundary is stated rather than implied: this is a text scan, so it can see a call site
        // that stopped passing the field but not a call site built by some other means. The load-bearing guard is in the
        // amendment writer, which refuses to amend under a revision that records no contract.
        const source = await readFile(join(process.cwd(), 'src/workflow/orchestrator.ts'), 'utf8');
        const call = source.slice(source.indexOf('createTaskRevisionIfChanged({'));
        const body = call.slice(0, call.indexOf('})'));
        expect(body).toContain('acceptanceContractHash: acceptanceContractHashOf(task.acceptance, task.acceptanceMatrix)');
    });
});
