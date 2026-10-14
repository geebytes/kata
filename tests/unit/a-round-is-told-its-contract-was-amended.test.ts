import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { acceptanceContractHashOf, createTask, readTask } from '../../src/core/task.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import { appendClaim, appendEvidence, ensureAssurance, freezeSubject, writePlan, writePolicy, writeSubject } from '../../src/store/ledger.js';
import { runLedgerCommand } from '../../src/cli/ledger.js';
import { runTasksCommand } from '../../src/cli/tasks.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { makeEvidence } from '../helpers/review.js';
import type { Claim } from '../../src/kernel/types.js';

/**
 * **A round that judges a corrected sentence has to be told the sentence was corrected.**
 *
 * The correction itself is the fact a reviewer would otherwise reconstruct — and could not: the criterion lives in
 * `task.json`, which is not in the change's diff, and a round handed only the amended text has no way to ask the question
 * that matters ("did this correction move the bar to the implementation, or the implementation to the bar?"). So the
 * amendment travels in the delivered package beside the declaration it changed, and a log nobody can read is carried as a
 * **named hole** rather than as "no amendment was ever recorded".
 */
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const original = 'the sandbox uses the same predicate cwd uses';
const corrected = 'arguments and cwd deliberately use different rules';

async function fixture(changeId: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-amendment-round-'));
    roots.push(root);
    await initLayout(root);
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'tmp'), { recursive: true });
    await writeFile(join(root, 'src', 'a.ts'), 'export const holds = true;\n', 'utf8');
    await createTask({
        root,
        id: changeId,
        title: 'A corrected contract',
        acceptance: [{ id: 'AC-1', statement: original }],
        ownedPaths: ['src/a.ts'],
        workflowProfile: { version: 1, isolationMode: 'current_worktree', developmentMode: 'tdd', reviewMode: 'strict', comet: { projectInit: 'not_requested', openStatus: 'acknowledged' } },
    });

    await writePolicy(root, changeId, defaultPolicy());
    const frozen = await freezeSubject({ root, paths: ['src/a.ts'] });
    if (!frozen.ok) throw new Error(frozen.error);
    await writeSubject(root, changeId, frozen.subject);
    await seal(root, changeId);
    await ensureAssurance(root, changeId, 'observed');
    const claim: Claim = {
        id: 'C-1', statement: 'the declared export holds', riskClass: 'boundary', severity: 'major',
        dependsOn: ['path:src/a.ts'], evidenceIds: ['E-1'], challengeIds: [], status: 'open',
        at: '2026-10-13T00:00:00.000Z', reopens: 0,
    };
    await appendClaim(root, changeId, claim);
    await appendEvidence(root, changeId, makeEvidence({
        id: 'E-1', type: 'executable_falsifier', command: 'grep -q holds src/a.ts',
        mutation: { file: 'src/a.ts', find: 'holds = true', replace: 'holds = false' },
    }));
    await writePlan(root, changeId, {
        tier: 'strict',
        readingSets: [{ claimId: 'C-1', paths: ['src/a.ts'], truncated: false }],
        requiredEvidence: [{ claimId: 'C-1', types: ['executable_falsifier'], minimumStrength: 3 }],
        discovery: { deadlineToolCalls: 100 },
    });
    return root;
}

/** The seal's own call, including the contract term it supplies (`orchestrator.ts`). */
async function seal(root: string, taskId: string): Promise<void> {
    const task = await readTask(root, taskId);
    await createTaskRevisionIfChanged({
        root,
        taskId,
        ownedPaths: ['src/a.ts'],
        checkIds: [],
        acceptanceContractHash: acceptanceContractHashOf(task.acceptance, task.acceptanceMatrix),
    });
}

/** Seal → amend → re-seal, which is the only order the mechanism allows. */
async function amend(root: string, changeId: string): Promise<Record<string, unknown>> {
    const file = join(root, 'tmp', 'amendment.json');
    await writeFile(file, `${JSON.stringify({ expectedStatement: original, statement: corrected })}\n`, 'utf8');
    const result = await runTasksCommand(['amend-acceptance', '--change', changeId, '--id', 'AC-1', '--file', file, '--reason', 'the criterion asserted a predicate the code does not have', '--by', 'author', '--root', root]);
    if (result.ok) await seal(root, changeId);
    return result;
}

type Request = {
    reviewPackage?: {
        declaration: {
            acceptance: Array<{ id?: string; statement: string }>;
            acceptanceAmendments: Array<{ acceptanceId: string; previousStatement: string; statement: string; reason: string; by: string; voidedRevision: string }> | { unreadable: string };
        };
    };
};

describe('a review round is handed the amendments that produced its contract', () => {
    it('carries the old text, the new text, the reason and the revision the correction voided', async () => {
        const changeId = 'corrected-contract';
        const root = await fixture(changeId);
        const amended = await amend(root, changeId);
        expect(amended.ok).toBe(true);

        await runLedgerCommand(['run', '--out', 'tmp/request.json'], { root, changeId });
        const request = JSON.parse(await readFile(join(root, 'tmp', 'request.json'), 'utf8')) as Request;

        expect(request.reviewPackage?.declaration.acceptance).toEqual([{ id: 'AC-1', statement: corrected }]);
        expect(request.reviewPackage?.declaration.acceptanceAmendments).toEqual([{
            version: 1,
            id: expect.stringMatching(/^amendment-/),
            taskId: changeId,
            acceptanceId: 'AC-1',
            previousStatement: original,
            statement: corrected,
            previousContractHash: expect.stringMatching(/^[0-9a-f]{64}$/),
            contractHash: expect.stringMatching(/^[0-9a-f]{64}$/),
            voidedRevision: amended.voidedRevision,
            reason: 'the criterion asserted a predicate the code does not have',
            by: 'author',
            at: expect.any(String),
        }]);
    });

    it('carries a log it cannot read as a named hole rather than as an empty history', async () => {
        const changeId = 'unreadable-log';
        const root = await fixture(changeId);
        await writeFile(join(root, '.kata/tasks', changeId, 'acceptance-amendments.jsonl'), '{ not json\n', 'utf8');

        await runLedgerCommand(['run', '--out', 'tmp/request.json'], { root, changeId });
        const request = JSON.parse(await readFile(join(root, 'tmp', 'request.json'), 'utf8')) as Request;

        const carried = request.reviewPackage?.declaration.acceptanceAmendments;
        // The distinction is the whole point: `[]` would tell the reviewer the contract was never corrected, which is a
        // claim about a file nobody could open.
        expect(Array.isArray(carried)).toBe(false);
        expect(carried).toMatchObject({ unreadable: expect.stringContaining('acceptance-amendments.jsonl') });
    });

    it('carries an empty list when the contract was never corrected, so absence is distinguishable from damage', async () => {
        const changeId = 'untouched-contract';
        const root = await fixture(changeId);

        await runLedgerCommand(['run', '--out', 'tmp/request.json'], { root, changeId });
        const request = JSON.parse(await readFile(join(root, 'tmp', 'request.json'), 'utf8')) as Request;

        expect(request.reviewPackage?.declaration.acceptanceAmendments).toEqual([]);
    });
});
