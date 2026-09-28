import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { appendEvidence, freezeSubject, recordVerdicts, reviewDir, writeSubject } from '../../src/store/ledger.js';
import { replayEvidence } from '../../src/store/replay.js';
import { verifyAll } from '../../src/producers/verifiers.js';
import { buildContext } from '../../src/store/verify-context.js';

/**
 * **Replay is the instrument behind "the evidence can be replayed", and it writes nothing.**
 *
 * The acceptance item was recorded as satisfied because every evidence item carries a `{before, mutated, after}` triple.
 * That is the *record* of a measurement; the record cannot say whether the measurement still holds, because the two things
 * that make it hold move — the artifact the check reads and the mutation site the falsifier edits. On this repository the
 * number is **0.353 over 17 recorded verdicts** (6 reproduce, 0 disagree, 11 can no longer be evaluated), and the cause is
 * legible: the cited test files were deleted with the retired route, so the command exits non-zero before any mutation.
 *
 * Two properties this file pins, both of which the first version got wrong or could have got wrong:
 *
 * 1. **Read-only.** A replay that recorded its findings would rewrite the ledger it is measuring.
 * 2. **Decay is not disagreement.** A check that cannot be evaluated and a check that does not redden both come back
 *    `refuted`, so classifying on the verdict alone filed nine un-runnable checks as "the record was wrong" — the first
 *    version of this split did exactly that and the aggregated number read as 9 disagreements instead of 0.
 */
let root: string;

afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
});

/** A falsifier whose mutation is real for the workspace below: the check greps a literal the mutation removes. */
const evidence = {
    id: 'E1',
    type: 'executable_falsifier' as const,
    command: "grep -q 'holds' artifact.txt",
    mutation: { file: 'artifact.txt', find: 'holds', replace: 'changed' },
};

async function ledgerWithVerdicts(): Promise<string> {
    root = await mkdtemp(join(tmpdir(), 'kata-replay-'));
    await initLayout(root);
    await createTask({ root, id: 'replay-task', title: 'Replay', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['artifact.txt'] });
    await writeFile(join(root, 'artifact.txt'), 'the literal holds here\n', 'utf8');
    const frozen = await freezeSubject({ root, paths: ['artifact.txt'] });
    if (!frozen.ok) throw new Error(frozen.error);
    await writeSubject(root, 'replay-task', frozen.subject);
    await appendEvidence(root, 'replay-task', evidence);
    // Verified the way the CLI verifies: through the shared context, so the recorded verdict is the real verifier's.
    const context = buildContext(root, frozen.subject, { timeoutMs: 30_000, producer: { runId: 'recording-run', actor: 'author' } });
    await recordVerdicts(root, 'replay-task', await verifyAll([evidence], context));
    return root;
}

/** Every file under the ledger directory, so "wrote nothing" is checkable rather than asserted. */
async function ledgerSnapshot(dir: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        out[entry.name] = await readFile(join(dir, entry.name), 'utf8');
    }
    return out;
}

describe('replay measures whether recorded verdicts still reproduce', () => {
    it('reproduces a verdict and writes nothing while doing it', async () => {
        const workspaceRoot = await ledgerWithVerdicts();
        const before = await ledgerSnapshot(reviewDir(workspaceRoot, 'replay-task'));

        const report = await replayEvidence({ root: workspaceRoot, changeId: 'replay-task' });

        expect(report).not.toHaveProperty('refused');
        if ('refused' in report) return;
        expect(report.replayed).toBe(1);
        expect(report.agrees).toBe(1);
        expect(report.replayRate).toBe(1);
        expect(report.items[0]?.recorded).toBe('supported');
        // The observation is the real triple, because the real verifier ran it.
        expect(report.items[0]?.observed).toContain('"mutated":1');

        // **Nothing written.** A replay that recorded its findings would rewrite the ledger it is measuring — and the
        // whole point of the instrument is to compare against the record, which has to survive being compared.
        await expect(ledgerSnapshot(reviewDir(workspaceRoot, 'replay-task'))).resolves.toEqual(before);
    });

    it('files an un-runnable check as decay, not as a disagreement', async () => {
        const workspaceRoot = await ledgerWithVerdicts();
        // The precondition of the check disappears: the artifact it greps is gone, so the command exits non-zero before
        // any mutation. The verifier reports `refuted` — the evidence item is invalid either way — and the *cause* is that
        // nothing can be evaluated, which is a different statement about the record than "it was wrong".
        await rm(join(workspaceRoot, 'artifact.txt'));

        const report = await replayEvidence({ root: workspaceRoot, changeId: 'replay-task' });

        if ('refused' in report) throw new Error(report.refused);
        expect(report.replayed).toBe(1);
        expect(report.agrees).toBe(0);
        expect(report.changed, 'the record is neither confirmed nor contradicted').toEqual([]);
        expect(report.decayed).toHaveLength(1);
        expect(report.items[0]?.observed).toContain('the check was already failing before any mutation');
        expect(report.replayRate).toBe(0);
        // And it says what it is not suitable for answering: a rate is not a quality judgement.
        expect(report.measures).toContain('not whether the checks are adequate');
    });

    it('refuses to replay against a subject that was never frozen, because there is nothing to compare against', async () => {
        root = await mkdtemp(join(tmpdir(), 'kata-replay-unfrozen-'));
        await mkdir(join(root, '.kata/tasks/replay-task/review'), { recursive: true });
        const report = await replayEvidence({ root, changeId: 'replay-task' });
        expect(report).toHaveProperty('refused');
        if (!('refused' in report)) return;
        expect(report.refused).toContain('ledger freeze');
    });
});
