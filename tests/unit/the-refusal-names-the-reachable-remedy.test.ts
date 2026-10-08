import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { readLedger } from '../../src/store/ledger.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { currentStatePath, reviewPath, taskDir } from '../../src/core/layout.js';

/**
 * **A review record answers a request, and the request is not the revision.**
 *
 * Measured in another checkout: a round's result was recorded for a revision; the ledger's claims were then restated, so the
 * next round answered a *different* question while the code — and therefore the sealed revision — stood still. Recording that
 * second round was refused, because the record's binding is content identity only (`revisionId`, the manifest hashes, the
 * frozen candidate) and the request it answered was nowhere in it.
 *
 * This guard pins the half that releases a blocked round: a record that answered **another** request does not block the
 * answer to this one. The same-request refusal and its remedy live in `the-refusal-names-the-reachable-remedy.test.ts`,
 * because two criteria that name one test file collapse into one check and one of them then has no evidence.
 */
const NOW = '2026-10-08T00:00:00.000Z';
const taskId = 'record-answers-a-request';
const roots: string[] = [];
let root: string;
/** The workspace the CLI resolves, restored after each case — the result file must live inside it. */
const originalCwd = process.cwd();

afterEach(async () => {
    process.chdir(originalCwd);
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-record-request-'));
    roots.push(root);
    // `--result-file` is resolved against the workspace, so the fixture *is* the workspace for this case.
    process.chdir(root);
    await mkdir(join(root, '.kata', 'tasks', taskId, 'review'), { recursive: true });
    await writeFile(join(root, 'subject.ts'), 'export const version = 1;\n');
    await writeFile(
        join(root, '.kata', 'tasks', taskId, 'task.json'),
        `${JSON.stringify({ id: taskId, title: 'T', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['subject.ts'], createdAt: NOW, updatedAt: NOW })}\n`,
    );
    await writeFile(
        currentStatePath(root, taskId),
        `${JSON.stringify({ taskId, phase: 'review', actor: { id: 'fixture', role: 'reviewer' }, updatedAt: NOW })}\n`,
    );
});

/**
 * A subject frozen through the **real chain**, so it carries the question.
 *
 * The hand-written subject beside this helper is the shape an independent round proved could hide a defect: it bypasses the
 * freeze, so it never hashed a question and every state that depends on one became untestable.
 */
async function freezeWithQuestion(): Promise<string> {
    const { appendClaim, freezeSubject: freezeThroughStore, writeSubject } = await import('../../src/store/ledger.js');
    if ((await readLedger(root, taskId)).claims.length === 0) {
        await appendClaim(root, taskId, {
            id: 'C1', statement: 'the question', riskClass: 'consistency', severity: 'major',
            dependsOn: ['path:subject.ts'], evidenceIds: [], challengeIds: [], status: 'open', at: NOW, reopens: 0,
        });
    }
    const frozen = await freezeThroughStore({ root, paths: ['subject.ts'], claims: (await readLedger(root, taskId)).claims });
    if (frozen.ok) await writeSubject(root, taskId, frozen.subject);
    return (await readLedger(root, taskId)).subjectAsDeclared?.revision ?? '';
}

/** A frozen ledger subject, which is what the review request is derived from. */
async function freezeSubject(revision: string): Promise<void> {
    await writeFile(
        join(taskDir(root, taskId), 'review', 'subject.json'),
        // The shape the review-subject schema declares: a revision and its path digests.
        `${JSON.stringify({ revision, pathDigests: { 'subject.ts': 'a'.repeat(64) }, declaredPaths: ['subject.ts'] })}\n`,
    );
    // The declaration in the result has to name claims the ledger holds, so the fixture holds one.
    await writeFile(
        join(taskDir(root, taskId), 'review', 'claims.json'),
        `${JSON.stringify([{ id: 'C1', statement: 's', riskClass: 'consistency', severity: 'major', dependsOn: ['path:subject.ts'], evidenceIds: [], challengeIds: [], status: 'open', at: NOW, reopens: 0 }])}\n`,
    );
}

async function recordedRound(subjectRevision?: string): Promise<string> {
    const { revision } = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: [] });
    await writeFile(
        reviewPath(root, taskId),
        `${JSON.stringify({
            revisionId: revision.id,
            manifestHash: revision.manifestHash,
            ...(subjectRevision ? { subjectRevision } : {}),
            findings: [{ id: 'R8-F1', taskId, acceptanceId: 'AC-1', severity: 'minor', path: 'subject.ts', message: 'm' }],
            status: 'pending',
            reviewRoute: 'adversarial',
        }, null, 2)}\n`,
    );
    return revision.id;
}

const RESULT = { taskId, status: 'pending', declaredCoverage: ['C1'], findings: [{ id: 'R9-F1', taskId, acceptanceId: 'AC-1', severity: 'major', path: 'subject.ts', message: 'm' }] };

async function writeResultFile(): Promise<string> {
    // Written at the fixture root and named **relative**, because the CLI resolves the flag against the workspace and
    // refuses a path outside it.
    await writeFile(join(root, 'result.json'), `${JSON.stringify(RESULT, null, 2)}\n`);
    return 'result.json';
}

describe('the refusal names a reachable remedy', () => {
    it('names the unreadable artefact even when the question is still derivable', async () => {
        // The state an independent round found one file over: a malformed `challenges.json` leaves the question derivable, so
        // a branch keyed on the question printed the generic remedy while the malformed gate refused its commands.
        const derived = await freezeWithQuestion();
        await recordedRound(derived);
        await writeFile(join(taskDir(root, taskId), 'review', 'challenges.json'), '{ not json');
        const path = join(root, 'result-no-coverage-2.json');
        await writeFile(path, `${JSON.stringify({ taskId, status: 'pending', findings: RESULT.findings }, null, 2)}\n`);

        const recorded = await runCommand('review', taskId, root, { reviewResultFile: 'result-no-coverage-2.json' });
        expect(recorded.success).toBe(false);
        expect(String(recorded.error)).toContain('challenges.json');
        // It names the set, and it names the whole chain: repairing the file does not move an unchanged question, so the
        // round is released only after the question moves (measured by an independent round, which ran exactly the printed
        // steps and was refused again).
        expect(String(recorded.error)).toContain('cannot be read (challenges.json)');
        expect(String(recorded.error)).toContain('restate a claim');
    });

    it('names repairing the record when the ledger cannot be read at all', async () => {
        // The fail-closed state this change added: an unreadable claims.json means nothing can be derived, and every command
        // the other states name is refused by the malformed gate — measured by an independent round, which found the
        // refusal still printing "restate a claim … then re-freeze" in exactly this state.
        const derived = await freezeWithQuestion();
        await recordedRound(derived);
        await writeFile(join(taskDir(root, taskId), 'review', 'claims.json'), '{ not json');
        // No declared coverage: with an unreadable claim set the coverage check refuses first, and that refusal is its own
        // fact (it names the file). This case is about the recording refusal, so it declares nothing.
        const path = join(root, 'result-no-coverage.json');
        await writeFile(path, `${JSON.stringify({ taskId, status: 'pending', findings: RESULT.findings }, null, 2)}\n`);

        const recorded = await runCommand('review', taskId, root, { reviewResultFile: 'result-no-coverage.json' });
        expect(recorded.success).toBe(false);
        expect(String(recorded.error)).toContain('cannot be read');
        expect(String(recorded.error)).toContain('repair or replace that file');
    });

    it('names the re-freeze when the subject never hashed the question', async () => {
        // The state an independent round measured as unremedied: a subject written before the question was part of the
        // identity, where restating a claim cannot move anything. Frozen the old way on purpose — this is the legacy shape.
        await freezeSubject('rev:cccc22222222cccc');
        await recordedRound((await readLedger(root, taskId)).subjectAsDeclared?.revision);

        const recorded = await runCommand('review', taskId, root, { reviewResultFile: await writeResultFile() });
        expect(recorded.success).toBe(false);
        expect(String(recorded.error)).toContain('does not carry the question');
        expect(String(recorded.error)).toContain('kata-cli ledger freeze');
    });

    it('names re-sealing when the record predates the request binding', async () => {
        // The other measured state: a record with no subjectRevision, where no comparison can say what it answered.
        await freezeWithQuestion();
        await recordedRound();

        const recorded = await runCommand('review', taskId, root, { reviewResultFile: await writeResultFile() });
        expect(recorded.success).toBe(false);
        expect(String(recorded.error)).toContain('predates the request binding');
        expect(String(recorded.error)).toContain('re-seal');
    });

    it('still refuses a second result for the same request, so a recorded round is not silently replaced', async () => {
        // The recorded round names the subject **as the ledger derives it**, which is what a real record carries; the
        // earlier fixture hand-wrote a revision inconsistent with its own digests, and an independent round showed that
        // this bypassed the chain the defect lives in.
        const derived = await freezeWithQuestion();
        expect(derived).not.toBe('');
        await recordedRound(derived);

        const recorded = await runCommand('review', taskId, root, { reviewResultFile: await writeResultFile() });
        expect(recorded.success).toBe(false);
        // And the refusal names a remedy that works in the state it fires from. The chain this used to print
        // (verify → gate approve → re-enter) was inert: re-entry deliberately preserves a recorded round (F-3), so the
        // refusal repeated verbatim after an operator ran it — measured by an independent round.
        expect(String(recorded.error)).toContain('restate a claim');
        expect(String(recorded.error)).toContain('does not clear a recorded round');
        expect(String(recorded.error)).not.toContain('--confirm-host-model');
    });

});
