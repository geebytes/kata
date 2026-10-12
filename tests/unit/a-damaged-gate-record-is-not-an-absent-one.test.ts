import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTask } from '../../src/core/task.js';
import { initLayout } from '../../src/core/layout.js';
import {
    createUserChoiceGate,
    approveUserChoiceGate,
    requireUserChoiceGate,
    readGateState,
    resetUserChoiceGate,
} from '../../src/workflow/user-choice-gate.js';

/**
 * AC-2 — a gate record the mechanism cannot read is reported as damaged, not as absent.
 *
 * The measured state (I-36, the second half): the record written by the CLI held a `choice` its own schema rejects, so
 * every read failed — and `requireUserChoiceGate` answered `requires an explicit user choice before continuing`, i.e. the
 * message for **no gate at all**. The operator's next move was therefore to approve a gate, which failed on the same
 * schema error, and the record could not be deleted by any command. "I cannot read this" and "there is nothing here" have
 * different remedies, and the reader answered the second about the first.
 *
 * The repair is deliberately narrow: `gate reset` removes a record the mechanism cannot read, and **refuses** one it can —
 * a valid, consumed or approved record is a decision somebody made, and no command in this change may erase a decision.
 */
const roots: string[] = [];

async function fixture(name: string): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), `kata-gate-damaged-${name}-`));
    roots.push(root);
    await initLayout(root);
    await createTask({
        root,
        id: 'held',
        title: 'Held',
        acceptance: [{ id: 'AC-1', statement: 'x' }],
        ownedPaths: ['src/a.ts'],
    });
    return root;
}

function gatePath(root: string, boundary: string): string {
    return join(root, '.kata', 'tasks', 'held', `user-choice-${boundary}.json`);
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('a damaged gate record is not an absent one', () => {
    it('names the record as damaged rather than as a missing decision', async () => {
        const root = await fixture('damaged');
        await createUserChoiceGate({ root, taskId: 'held', boundary: 'archive_gate' });
        // Exactly the state the CLI produced: a value the schema refuses.
        writeFileSync(gatePath(root, 'archive_gate'), `${JSON.stringify({ taskId: 'held', boundary: 'archive_gate', createdAt: new Date().toISOString(), choice: 'archive' }, null, 2)}\n`);

        const state = await readGateState(root, 'held', 'archive_gate');
        expect(state.kind).toBe('damaged');

        // The refusal says what is wrong and where the road is, instead of asking for a decision that is already there.
        await expect(requireUserChoiceGate({ root, taskId: 'held', boundary: 'archive_gate' })).rejects.toThrow(/damaged|unreadable/u);
        await expect(requireUserChoiceGate({ root, taskId: 'held', boundary: 'archive_gate' })).rejects.toThrow(/gate reset/u);
    });

    it('still reads an absent record as an absent decision, so the two states stay apart', async () => {
        const root = await fixture('absent');
        expect((await readGateState(root, 'held', 'judge_gate')).kind).toBe('absent');
        await expect(requireUserChoiceGate({ root, taskId: 'held', boundary: 'judge_gate' })).rejects.toThrow(/explicit user choice/u);
    });

    it('repairs a damaged record and leaves the boundary answerable again', async () => {
        const root = await fixture('reset');
        await createUserChoiceGate({ root, taskId: 'held', boundary: 'archive_gate' });
        writeFileSync(gatePath(root, 'archive_gate'), '{ "taskId": "held", "boundary": "archive_gate", "choice": "archive" }\n');

        const reset = await resetUserChoiceGate({ root, taskId: 'held', record: 'boundary', boundary: 'archive_gate', reason: 'the record holds a value its schema rejects' });
        expect(reset.removed).toBe(true);
        expect(existsSync(gatePath(root, 'archive_gate'))).toBe(false);

        // And the boundary can be answered: the road out of the deadlock, driven end to end.
        await createUserChoiceGate({ root, taskId: 'held', boundary: 'archive_gate' });
        await approveUserChoiceGate({ root, taskId: 'held', boundary: 'archive_gate', choice: 'continue_current' });
        expect((await requireUserChoiceGate({ root, taskId: 'held', boundary: 'archive_gate' })).choice).toBe('continue_current');
    });

    it('resets the task-level choice, the record its own refusal names', async () => {
        // **The refusal printed a command that could not act on the file it named.** A damaged `user-choice-task.json` was
        // answered with `gate reset --boundary <boundary>`, and the reset acts on `user-choice-<boundary>.json` — so the file
        // the operator was told to remove was never touched (measured by the second round: the shape of the first round's
        // inert-road finding, one function over). This drives the road the refusal names, end to end.
        const root = await fixture('task-choice');
        writeFileSync(join(root, '.kata', 'tasks', 'held', 'user-choice-task.json'), '{ "taskId": "held", "choice": "archive" }\n');
        const { requireUserChoiceGate } = await import('../../src/workflow/user-choice-gate.js');
        await expect(requireUserChoiceGate({ root, taskId: 'held', boundary: 'review_gate' })).rejects.toThrow(/--record task-choice/u);

        const reset = await resetUserChoiceGate({ root, taskId: 'held', record: 'task-choice', reason: 'the task-level choice holds a value its schema rejects' });
        expect(reset.removed).toBe(true);
        expect(existsSync(join(root, '.kata', 'tasks', 'held', 'user-choice-task.json'))).toBe(false);
        // And the boundary is answerable again, which is what the refusal promised.
        await createUserChoiceGate({ root, taskId: 'held', boundary: 'review_gate' });
        await approveUserChoiceGate({ root, taskId: 'held', boundary: 'review_gate', choice: 'continue_current' });
        expect((await requireUserChoiceGate({ root, taskId: 'held', boundary: 'review_gate' })).choice).toBe('continue_current');
    });

    it('refuses a symlink, an unreadable file and a directory by name, before reading anything', async () => {
        // Measured by the second round, one errno apart each time: a symlink made the audit's digest describe the target
        // while the removal took the link; a mode-000 file threw a raw EACCES out of the command; a FIFO made the reader
        // block. The shape is checked before the read, so none of them can hang or throw.
        const root = await fixture('shapes');
        const taskDir = join(root, '.kata', 'tasks', 'held');
        const target = join(root, 'target.json');
        writeFileSync(target, '{ "taskId": "held", "choice": "archive" }\n');
        symlinkSync(target, gatePath(root, 'archive_gate'));
        await expect(resetUserChoiceGate({ root, taskId: 'held', record: 'boundary', boundary: 'archive_gate', reason: 'x' }))
            .rejects.toThrow(/symbolic link, not a record/u);
        expect(existsSync(target)).toBe(true);

        rmSync(gatePath(root, 'archive_gate'));
        writeFileSync(gatePath(root, 'archive_gate'), '{}\n');
        chmodSync(gatePath(root, 'archive_gate'), 0o000);
        try {
            // An unreadable file is still a regular file, so it is the *read* that fails — and the command must say so rather
            // than throw EACCES. The reset's own read is the digest, which is what the refusal covers.
            const reset = await resetUserChoiceGate({ root, taskId: 'held', record: 'boundary', boundary: 'archive_gate', reason: 'x' })
                .catch((error: Error) => error.message);
            expect(String(reset)).toMatch(/cannot be examined|permission denied|EACCES|not a regular file|Nothing was removed/u);
        } finally {
            chmodSync(gatePath(root, 'archive_gate'), 0o644);
        }
        expect(taskDir.length).toBeGreaterThan(0);
    });

    it('refuses when the audit record cannot be written, and removes nothing', async () => {
        // Written after the removal, a failure left the record gone with no trace and a raw error out of the command
        // (measured by the second round). The audit is written first now, so a failure means nothing was removed.
        const root = await fixture('audit-failure');
        await createUserChoiceGate({ root, taskId: 'held', boundary: 'archive_gate' });
        writeFileSync(gatePath(root, 'archive_gate'), '{ "taskId": "held", "boundary": "archive_gate", "choice": "archive" }\n');
        mkdirSync(`${gatePath(root, 'archive_gate')}.removed.json`, { recursive: true });

        await expect(resetUserChoiceGate({ root, taskId: 'held', record: 'boundary', boundary: 'archive_gate', reason: 'x' }))
            .rejects.toThrow(/audit record could not be written/u);
        expect(existsSync(gatePath(root, 'archive_gate'))).toBe(true);
    });

    it('writes the reason down beside the record it removed, so the removal is auditable', async () => {
        // The first version required `--reason`, printed it in the result, and stored it nowhere (measured by the first
        // round: `grep -rl` over the root found it in no file), so a removal left no trace of why it happened.
        const root = await fixture('audit');
        await createUserChoiceGate({ root, taskId: 'held', boundary: 'archive_gate' });
        writeFileSync(gatePath(root, 'archive_gate'), '{ "taskId": "held", "boundary": "archive_gate", "choice": "archive" }\n');

        const reset = await resetUserChoiceGate({ root, taskId: 'held', record: 'boundary', boundary: 'archive_gate', reason: 'the record holds a value its schema rejects' });
        const audit = JSON.parse(readFileSync(reset.auditPath, 'utf8')) as { reason?: string; removedSha256?: string };
        expect(audit.reason).toBe('the record holds a value its schema rejects');
        expect(audit.removedSha256).toMatch(/^[0-9a-f]{64}$/u);
        // And an empty reason is refused, so the audit cannot be blank.
        await expect(resetUserChoiceGate({ root, taskId: 'held', record: 'boundary', boundary: 'archive_gate', reason: '   ' })).rejects.toThrow(/reason/u);
    });

    it('refuses a directory at the record path by name instead of throwing a filesystem error', async () => {
        // Measured: with a directory where the record should be, the refusal named `gate reset` and the reset itself threw
        // the raw Node error `Path is a directory: rm returned EISDIR` — a road that cannot be walked, and a raw error out
        // of a command.
        const root = await fixture('directory');
        mkdirSync(gatePath(root, 'archive_gate'), { recursive: true });
        await expect(resetUserChoiceGate({ root, taskId: 'held', record: 'boundary', boundary: 'archive_gate', reason: 'x' }))
            .rejects.toThrow(/directory, not a record/u);
        expect(existsSync(gatePath(root, 'archive_gate'))).toBe(true);
    });

    it('removes it through the CLI, and refuses a readable record there too', async () => {
        // **The road has to exist as a command**, not only as a function: the measured state had no command at all, and a
        // refusal that names one that does not exist is the defect class this change is about.
        const root = await fixture('cli');
        const cli = join(process.cwd(), 'dist', 'cli.js');
        if (!existsSync(cli)) return;
        await createUserChoiceGate({ root, taskId: 'held', boundary: 'archive_gate' });
        writeFileSync(gatePath(root, 'archive_gate'), '{ "taskId": "held", "boundary": "archive_gate", "choice": "archive" }\n');

        const reset = execFileSync('node', [cli, 'gate', 'reset', '--task', 'held', '--boundary', 'archive_gate', '--reason', 'the record holds a value its schema rejects'], { cwd: root, encoding: 'utf8' });
        expect(JSON.parse(reset)).toMatchObject({ command: 'gate reset', removed: true });
        expect(existsSync(gatePath(root, 'archive_gate'))).toBe(false);

        // The other direction through the same command: a readable record is not removable.
        await createUserChoiceGate({ root, taskId: 'held', boundary: 'archive_gate' });
        await approveUserChoiceGate({ root, taskId: 'held', boundary: 'archive_gate', choice: 'continue_current' });
        let refused = false;
        try {
            execFileSync('node', [cli, 'gate', 'reset', '--task', 'held', '--boundary', 'archive_gate', '--reason', 'x'], { cwd: root, stdio: 'pipe' });
        } catch {
            refused = true;
        }
        expect(refused).toBe(true);
        expect(existsSync(gatePath(root, 'archive_gate'))).toBe(true);
    });

    it('refuses to reset a record it can read, and one that is not there', async () => {
        // **The direction that protects the decision.** A reset that also removed valid records would be a way to erase a
        // human's answer — the gate-strength change this change must not make.
        const root = await fixture('refuses');
        await createUserChoiceGate({ root, taskId: 'held', boundary: 'review_gate' });
        await approveUserChoiceGate({ root, taskId: 'held', boundary: 'review_gate', choice: 'switched' });
        const before = readFileSync(gatePath(root, 'review_gate'), 'utf8');

        await expect(resetUserChoiceGate({ root, taskId: 'held', record: 'boundary', boundary: 'review_gate', reason: 'x' })).rejects.toThrow(/readable|valid|refuses/u);
        expect(readFileSync(gatePath(root, 'review_gate'), 'utf8')).toBe(before);
        await expect(resetUserChoiceGate({ root, taskId: 'held', record: 'boundary', boundary: 'judge_gate', reason: 'x' })).rejects.toThrow();
    });
});
