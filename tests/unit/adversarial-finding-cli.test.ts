import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { runAdversarialCommand } from '../../src/cli/ops.js';
import { readAdversarialRecord, writeAdversarialRecord } from '../../src/quality/adversarial.js';
import { readObligations } from '../../src/quality/repair-obligations.js';

/**
 * `kata-cli adversarial finding add --change <task-id>` is the command the generated review and verify Skills, the
 * adversarial brief and `docs/operations.md` all hand a reviewer for reporting a finding **while the round runs** — the
 * mechanism that keeps a crash from costing every finding the round confirmed.
 *
 * It could not work. `runAdversarialCommand` read the task id with `parseChangeArg(rest)`, where `rest` still began with
 * the `add` action word, and `parseChangeArg` returns the first non-flag token — that word. The task id resolved to
 * `add` and the command failed with `ENOENT: .kata/tasks/add/adversarial-review.json`. `adversarial note` was unaffected
 * because its `rest` carries no leading action word, which is why the two documented siblings behaved differently.
 */
describe('a finding can be reported as it is confirmed', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function fixture(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-finding-cli-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'finding-cli', title: 'Finding CLI', acceptance: [{ id: 'AC-1', statement: 'x' }] });
        return root;
    }

    async function findingFile(root: string, id: string): Promise<string> {
        const path = join(root, 'finding.json');
        await writeFile(path, JSON.stringify({
            id,
            taskId: 'finding-cli',
            severity: 'major',
            message: 'the transcript accumulates across seals',
            path: 'src/process/run.ts',
        }), 'utf8');
        return path;
    }

    it('records a finding against the task named by --change, not against the action word', async () => {
        const root = await fixture();
        const previousCwd = process.cwd();
        // `runAdversarialCommand` resolves its workspace from the cwd, so the fixture has to be the cwd for the command to
        // address the task it names (the sibling brief-binding suite does the same).
        process.chdir(root);
        try {
        // A round in flight has already recorded its pass — that is the state `finding add` extends, and the state the
        // ENOENT used to name: `.kata/tasks/add/adversarial-review.json`.
        await writeAdversarialRecord(root, 'finding-cli', {
            node: 'review',
            status: 'recorded',
            revisionId: 'revision-in-flight',
            createdAt: new Date().toISOString(),
            executedInFreshContext: true,
            contextNote: 'The round is running; findings are reported as they are confirmed.',
            attempts: [{ hypothesis: 'the artifact is replaced', method: 're-collected it', outcome: 'refuted' }],
            findings: [],
        });
        const file = await findingFile(root, 'reported-mid-round');

        const result = await runAdversarialCommand(['finding', 'add', '--change', 'finding-cli', '--node', 'review', '--from-file', file]);

        expect(result.findingId).toBe('reported-mid-round');
        expect(result.taskId).toBe('finding-cli');
        // And it is durable before the verdict is recorded — that is the whole point of reporting it now.
        const record = await readAdversarialRecord(root, 'finding-cli', 'review');
        expect((record?.findings ?? []).map((finding) => finding.id)).toContain('reported-mid-round');
        // …and it owes a repair, which is what lets the batch it opens be closed later. Without this the batch has no
        // finding it can account for as `answered`, however well the repair goes.
        const obligations = await readObligations(root, 'finding-cli');
        expect(obligations.map((obligation) => obligation.findingId)).toContain('reported-mid-round');
        expect(obligations.map((obligation) => obligation.severity)).toContain('major');
        } finally {
            process.chdir(previousCwd);
        }
    });

    it('fails with a usage error when --change is absent, never with an ENOENT about a task called add', async () => {
        const root = await fixture();
        const previousCwd = process.cwd();
        process.chdir(root);
        try {
            const file = await findingFile(root, 'unaddressable');

            // The old failure was an ENOENT on `.kata/tasks/add/adversarial-review.json` — the assertion is on the reason,
            // because "it failed" was already true and was the bug.
            await expect(runAdversarialCommand(['finding', 'add', '--node', 'review', '--from-file', file]))
                .rejects.toThrow(/Usage: kata-cli adversarial finding add --change/);
        } finally {
            process.chdir(previousCwd);
        }
    });
});
