import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
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
    consumeUserChoiceGate,
} from '../../src/workflow/user-choice-gate.js';

import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { bindsToRevision, currentRevisionIdentity } from '../../src/workflow/verdict-binding.js';

/**
 * **How many times one verb reads the current-revision pointer.**
 *
 * Round 9's F2: the round-8 repair handed the identity to `assertRevision` but left it asking a predicate that derived it
 * again, so one approve and one require each read a non-atomically written pointer twice — the shape `verdict-binding.ts`
 * names as forbidden at the very site it introduced. The count is the only instrument that can see the difference between
 * the two-read version and the one-read version, so it is counted through the reader rather than inferred.
 */
const pointerReads = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../src/workflow/revision.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../../src/workflow/revision.js')>();
    return {
        ...original,
        readCurrentTaskRevisionState: async (...args: Parameters<typeof original.readCurrentTaskRevisionState>) => {
            pointerReads.count += 1;
            return original.readCurrentTaskRevisionState(...args);
        },
    };
});

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

function taskChoicePath(root: string): string {
    return join(root, '.kata', 'tasks', 'held', 'user-choice-task.json');
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

    // **The shape, not every byte.** The reader asks the entry's kind before it opens anything, so a link, a directory or a
    // FIFO is refused without a read; an *unreadable regular file* is a regular file whose read fails, and it is refused by
    // the named reason the reset reports (round 4's F6 measured the title claiming "before reading anything").
    it('refuses a symlink, an unreadable file and a directory by name, before the record is read as a record', async () => {
        // Measured by the second round, one errno apart each time: a symlink made the audit's digest describe the target
        // while the removal took the link; a mode-000 file threw a raw EACCES out of the command; a FIFO made the reader
        // block. The shape is checked before the read, so none of them can hang or throw.
        const root = await fixture('shapes');
        const target = join(root, 'target.json');
        writeFileSync(target, '{ "taskId": "held", "choice": "archive" }\n');
        symlinkSync(target, gatePath(root, 'archive_gate'));
        await expect(resetUserChoiceGate({ root, taskId: 'held', record: 'boundary', boundary: 'archive_gate', reason: 'x' }))
            .rejects.toThrow(/not a regular file/u);
        expect(existsSync(target)).toBe(true);

        rmSync(gatePath(root, 'archive_gate'));
        writeFileSync(gatePath(root, 'archive_gate'), '{}\n');
        chmodSync(gatePath(root, 'archive_gate'), 0o000);
        try {
            // An unreadable file is still a regular file, so it is the *read* that fails — and the command must say so rather
            // than throw EACCES. The reset's own read is the digest, which is what the refusal covers.
            const reset = await resetUserChoiceGate({ root, taskId: 'held', record: 'boundary', boundary: 'archive_gate', reason: 'x' })
                .catch((error: Error) => error.message);
            // **The sentence, not a vocabulary that also accepts the raw errno.** The first version accepted `EACCES` and
            // `permission denied` alongside the named refusal, so the one shape round 3 measured — a raw filesystem error out of
            // the command — satisfied the case. What is asserted is that the refusal is the named one and names a road.
            expect(String(reset)).toMatch(/cannot be read .*so its content cannot be summarised and nothing was removed/u);
            expect(String(reset)).toMatch(/chmod \+r|rm /u);
        } finally {
            chmodSync(gatePath(root, 'archive_gate'), 0o644);
        }
    });

    it('refuses when the audit record cannot be written, and removes nothing', async () => {
        // Written after the removal, a failure left the record gone with no trace and a raw error out of the command
        // (measured by the second round). The audit is written first now, so a failure means nothing was removed — and the
        // only way to make the write fail is a directory that cannot be written into, since a *taken* audit name is handled
        // by using the next free one (round 3's F3 measured the deadlock the `wx` flag created: a record reset twice was
        // refused forever).
        const root = await fixture('audit-failure');
        await createUserChoiceGate({ root, taskId: 'held', boundary: 'archive_gate' });
        writeFileSync(gatePath(root, 'archive_gate'), '{ "taskId": "held", "boundary": "archive_gate", "choice": "archive" }\n');
        const taskDir = join(root, '.kata', 'tasks', 'held');
        chmodSync(taskDir, 0o500);
        try {
            await expect(resetUserChoiceGate({ root, taskId: 'held', record: 'boundary', boundary: 'archive_gate', reason: 'x' }))
                .rejects.toThrow(/audit record could not be written/u);
        } finally {
            chmodSync(taskDir, 0o755);
        }
        expect(existsSync(gatePath(root, 'archive_gate'))).toBe(true);
    });

    it('uses the next free audit name, so a second reset is not refused forever', async () => {
        // Round 3's F3: `{ flag: 'wx' }` refused to overwrite, so once a record had been reset, resetting it again was
        // permanently refused — a deadlock created by the repair for the one it removed. Both audits are kept.
        const root = await fixture('two-audits');
        for (const round of [1, 2]) {
            await createUserChoiceGate({ root, taskId: 'held', boundary: 'archive_gate' });
            writeFileSync(gatePath(root, 'archive_gate'), `{ "taskId": "held", "boundary": "archive_gate", "choice": "archive", "round": ${round} }\n`);
            const reset = await resetUserChoiceGate({ root, taskId: 'held', record: 'boundary', boundary: 'archive_gate', reason: `removal ${round}` });
            expect(reset.auditPath).toMatch(round === 1 ? /removed\.json$/u : /removed\.2\.json$/u);
        }
        const first = JSON.parse(readFileSync(`${gatePath(root, 'archive_gate')}.removed.json`, 'utf8')) as { reason?: string; removedSha256?: string };
        const second = JSON.parse(readFileSync(`${gatePath(root, 'archive_gate')}.removed.2.json`, 'utf8')) as { reason?: string; removedSha256?: string };
        expect([first.reason, second.reason]).toEqual(['removal 1', 'removal 2']);
        // **The digest is asserted, not only stored.** The audit exists so the record that could not be read stays
        // identifiable; a blank digest would make it a reason with no evidence, which the harness measured as unobserved
        // (E10 was `refuted` while this line was missing).
        expect(first.removedSha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(second.removedSha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(first.removedSha256).not.toBe(second.removedSha256);
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

    it('refuses to remove a record it can read, because a decision is not damage', async () => {
        // **The branch with no case until now.** E3's declared mutation (`if (state.kind === 'usable') {` -> `if (false) {`)
        // applied and stayed green: the sweep asserted the damaged path and the shapes, and nothing asserted the refusal that
        // keeps a *readable* record — a decision somebody made — out of the removal rule. Measured by the round that read this
        // revision: `mutated: 0`. What the mutation breaks is here, so E3 decides it again.
        const root = await fixture('readable');
        await createUserChoiceGate({ root, taskId: 'held', boundary: 'archive_gate' });
        await approveUserChoiceGate({ root, taskId: 'held', boundary: 'archive_gate', choice: 'continue_current' });
        const before = readFileSync(gatePath(root, 'archive_gate'), 'utf8');

        await expect(resetUserChoiceGate({ root, taskId: 'held', record: 'boundary', boundary: 'archive_gate', reason: 'the record is a decision, not damage' }))
            .rejects.toThrow(/readable and still speaks for the current content, so it is a live decision rather than damage/u);
        expect(readFileSync(gatePath(root, 'archive_gate'), 'utf8'), 'a record that held a decision is still there').toBe(before);
    });

    it('refuses a directory on the task-level path by name, instead of letting EISDIR out of the command', async () => {
        // **The same record kind as a boundary's, one directory over.** The shape rule covered the boundary path and not this
        // one, so the task-level reset read the directory, threw its raw errno, and left the entry in place (round 3's F2).
        const root = await fixture('task-dir');
        mkdirSync(taskChoicePath(root), { recursive: true });

        await expect(resetUserChoiceGate({ root, taskId: 'held', record: 'task-choice', reason: 'x' }))
            .rejects.toThrow(/is a directory, not a regular file/u);
        expect(existsSync(taskChoicePath(root)), 'the directory is not a record, and nothing removed it').toBe(true);
    });

    it('refuses a symbolic link on the task-level path, so a removal cannot take an entry other than the record it read', async () => {
        const root = await fixture('task-link');
        const target = join(root, 'elsewhere.json');
        writeFileSync(target, '{"version":1,"taskId":"held","choice":"continue_current"}\n');
        symlinkSync(target, taskChoicePath(root));

        await expect(resetUserChoiceGate({ root, taskId: 'held', record: 'task-choice', reason: 'x' }))
            .rejects.toThrow(/is a symbolic link, not a regular file/u);
        expect(readFileSync(target, 'utf8'), 'the file the link pointed at still holds the record').toContain('continue_current');
    });

    it('names the shape from the entry rather than inferring it from a read error', async () => {
        // **The property the FIFO case is about, decided where a hang cannot hide it.** The reader asks the shape before it
        // opens anything, so a directory is refused *as a directory*; a reader that only tried to read would report whatever
        // the read produced (`EISDIR`) and treat the entry as a regular file a repair may remove (round 3's F2 and F6).
        const root = await fixture('shape-dir');
        mkdirSync(gatePath(root, 'archive_gate'), { recursive: true });

        const state = await readGateState(root, 'held', 'archive_gate');
        expect(state.kind).toBe('damaged');
        expect(state.kind === 'damaged' ? state.why : '', 'the shape is named, not the errno of a read that was never needed')
            .toMatch(/is a directory, not a regular file/u);
        expect(state.kind === 'damaged' ? state.regular : undefined, 'a directory is not a record a repair may remove').toBe(false);
        await expect(resetUserChoiceGate({ root, taskId: 'held', record: 'boundary', boundary: 'archive_gate', reason: 'x' }))
            .rejects.toThrow(/is a directory, not a regular file/u);
    });

    it('removes a record that no longer speaks for the current content, and says why in the audit', async () => {
        // **The road this change's refusals print.** A gate bound to a revision the task has left is not a decision about
        // the content under consideration, so removing it — with the reason already required — is the repair; a record that
        // still binds is refused by the case below. Measured before this repair (round 4's F1): `gate reset` refused both,
        // `gate approve` refused the consumed record, and the creating command is refused in the phase that prints the
        // stale refusal, so the state had no road at all.
        const root = await fixture('stale-gate');
        // Written by hand because the mechanism no longer produces this shape: it binds every record it creates (to the
        // sealed content or, before a seal, to the declared content). An id-only record is what the repository's older
        // records are, and it is exactly the state this case is about.
        writeFileSync(gatePath(root, 'archive_gate'), `${JSON.stringify({ taskId: 'held', boundary: 'archive_gate', revisionId: 'revision-the-task-has-left', createdAt: new Date().toISOString() })}\n`);

        const reset = await resetUserChoiceGate({ root, taskId: 'held', record: 'boundary', boundary: 'archive_gate', reason: 'the record is bound to a revision the task has left' });
        expect(reset.removed).toBe(true);
        expect(existsSync(gatePath(root, 'archive_gate')), 'the obsolete record is gone, so the boundary can be answered again').toBe(false);
        const audit = JSON.parse(readFileSync(`${gatePath(root, 'archive_gate')}.removed.json`, 'utf8')) as { reason: string; removedSha256: string };
        expect(audit.reason).toBe('the record is bound to a revision the task has left');
        expect(audit.removedSha256).toMatch(/^[0-9a-f]{64}$/u);
    });

    it('names a road that runs for an entry that is not a record', async () => {
        // **The road by shape** (round 6's F1). Every damaged sentence named `gate reset`, and that verb refuses a non-regular
        // entry by design — it removes records, not links or directories — so the road printed for a symlink, a directory, a
        // FIFO or a socket was closed where it was printed, and the boundary could only be unlocked by a hand-written removal
        // nobody had named. The remedy now names the shell road for the shape, and `rm` on a link removes the link only.
        const root = await fixture('shape-road');
        const target = join(root, 'elsewhere.json');
        writeFileSync(target, '{}\n');
        symlinkSync(target, gatePath(root, 'archive_gate'));

        const linkRefusal = await approveUserChoiceGate({ root, taskId: 'held', boundary: 'archive_gate', choice: 'continue_current' }).catch((error: Error) => error.message);
        expect(String(linkRefusal), 'a symlink is not a record, so the road is the operator removing the entry').toMatch(/`rm .*archive_gate.json`/u);
        expect(String(linkRefusal), 'and it is not the verb that refuses this shape').not.toMatch(/gate reset/u);

        rmSync(gatePath(root, 'archive_gate'));
        mkdirSync(gatePath(root, 'archive_gate'));
        const dirRefusal = await approveUserChoiceGate({ root, taskId: 'held', boundary: 'archive_gate', choice: 'continue_current' }).catch((error: Error) => error.message);
        expect(String(dirRefusal)).toMatch(/`rmdir .*archive_gate.json`/u);
    });

    it('binds an answer written before the first seal to the declared content', async () => {
        // **Round 6's F3.** With no revision yet, the record carried neither `revisionId` nor `manifestHash`, and
        // `assertRevision` accepts an unbound record forever — so the human's answer authorised content they had never seen,
        // and kept authorising after that content changed. The binding is the same fact the seal records.
        const root = await fixture('unsealed-binding');
        mkdirSync(join(root, 'src'), { recursive: true });
        writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
        await createUserChoiceGate({ root, taskId: 'held', boundary: 'archive_gate' });
        await approveUserChoiceGate({ root, taskId: 'held', boundary: 'archive_gate', choice: 'continue_current' });

        const record = JSON.parse(readFileSync(gatePath(root, 'archive_gate'), 'utf8')) as { manifestHash?: string };
        expect(record.manifestHash, 'the answer names the content it was given about').toMatch(/^[0-9a-f]{64}$/u);

        // Move that content: the answer no longer speaks for it, and the refusal names the road out.
        writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 2;\n');
        await expect(requireUserChoiceGate({ root, taskId: 'held', boundary: 'archive_gate' })).rejects.toThrow(/no longer speaks for the current content/u);
    });

    it('names the shell road for a task-level record whose entry is not a record', async () => {
        // **Round 7's F1: the adjacent reader.** The boundary branches learned to name the road by shape; the task-level
        // branch still printed `gate reset --record task-choice`, which refuses a symlink or a directory — the same defect
        // one reader over, which is why it is asserted here as well.
        const root = await fixture('task-shape-road');
        const target = join(root, 'elsewhere.json');
        writeFileSync(target, '{}\n');
        symlinkSync(target, taskChoicePath(root));

        const refusal = await requireUserChoiceGate({ root, taskId: 'held', boundary: 'review_gate' }).catch((error: Error) => error.message);
        expect(String(refusal), 'the task-level damage names the road that runs for its shape').toMatch(/`rm .*user-choice-task.json`/u);
        expect(String(refusal), 'and not the verb that refuses this shape').not.toMatch(/gate reset/u);
    });

    it('does not reuse a task-level answer given before the first seal once the declared content moves', async () => {
        // **Round 7's F2, the second copy of one fact.** `recordTaskChoice` called `currentRevisionIdentity` directly, so a
        // `--for-task` answer given before the first seal carried no content binding, `bindsToRevision` read an unbound
        // record as binding, and a later boundary reused an answer the human had given about other content.
        const root = await fixture('for-task-binding');
        mkdirSync(join(root, 'src'), { recursive: true });
        writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
        await createUserChoiceGate({ root, taskId: 'held', boundary: 'implementation_gate' });
        await approveUserChoiceGate({ root, taskId: 'held', boundary: 'implementation_gate', choice: 'continue_current', forTask: true });

        const recorded = JSON.parse(readFileSync(taskChoicePath(root), 'utf8')) as { manifestHash?: string };
        expect(recorded.manifestHash, 'the task-level answer names the content it was given about').toMatch(/^[0-9a-f]{64}$/u);

        writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 2;\n');
        await expect(requireUserChoiceGate({ root, taskId: 'held', boundary: 'review_gate' }))
            .rejects.toThrow(/explicit user choice/u);
    });

    it('names a FIFO and a socket as themselves, without opening either one', async () => {
        // **Round 8's F4: the branch that names these two shapes had no case at all**, so a change that folded them into
        // "not a regular file" would have reddened nothing. Both are created in-process; the shape rule is asked before any
        // read, which is why a FIFO — whose read never returns — is a bounded reading here rather than a hang.
        const root = await fixture('shapes-fifo-socket');
        const fifoPath = gatePath(root, 'judge_gate');
        execFileSync('mkfifo', [fifoPath]);
        const fifoRefusal = await requireUserChoiceGate({ root, taskId: 'held', boundary: 'judge_gate' }).catch((error: Error) => error.message);
        expect(String(fifoRefusal), 'a FIFO is named as a FIFO').toMatch(/is a FIFO, not a regular file/u);
        rmSync(fifoPath);

        const socketPath = gatePath(root, 'review_gate');
        const server = createServer();
        await new Promise<void>((resolve) => { server.listen(socketPath, resolve); });
        try {
            const socketRefusal = await requireUserChoiceGate({ root, taskId: 'held', boundary: 'review_gate' }).catch((error: Error) => error.message);
            expect(String(socketRefusal), 'a socket is named as a socket').toMatch(/is a socket, not a regular file/u);
        } finally {
            await new Promise<void>((resolve) => { server.close(() => resolve()); });
        }
    });

    it('binds a gate at the moment it is created, so an answer to an ask whose content moved is refused', async () => {
        // **Round 8's F3: the third writer.** `createUserChoiceGate` derived its identity directly, so a gate created before
        // the first seal carried no binding and any later answer was accepted — including one given about content that had
        // moved since the ask. The ask names the content it is about, and the refusal names the road (`gate reset` removes a
        // record that no longer speaks for the current content, and a record bound to the old content does not).
        const root = await fixture('created-binding');
        mkdirSync(join(root, 'src'), { recursive: true });
        writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
        await createUserChoiceGate({ root, taskId: 'held', boundary: 'implementation_gate' });

        const asked = JSON.parse(readFileSync(gatePath(root, 'implementation_gate'), 'utf8')) as { manifestHash?: string };
        expect(asked.manifestHash, 'the ask names the content it is about').toMatch(/^[0-9a-f]{64}$/u);

        writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 2;\n');
        await expect(approveUserChoiceGate({ root, taskId: 'held', boundary: 'implementation_gate', choice: 'continue_current' }))
            .rejects.toThrow(/no longer speaks for the current content/u);
        // And the road it names runs: the record bound to the old content is not a live decision about this one.
        const reset = await resetUserChoiceGate({ root, taskId: 'held', record: 'boundary', boundary: 'implementation_gate', reason: 'the ask is about content that moved' });
        expect(reset.removed).toBe(true);
    });

    it('names the shell road when reset refuses an entry that is not a record', async () => {
        // **Round 8's F1.** `shapeRoad` was called by three sentences and not by the verb every other sentence names, so the
        // removal command refused a symlink, a directory, a FIFO or a socket without showing a road — the same defect one
        // site over, and no case asserted this sentence at all.
        const root = await fixture('reset-shape-road');
        const target = join(root, 'elsewhere.json');
        writeFileSync(target, '{}\n');
        symlinkSync(target, gatePath(root, 'archive_gate'));

        const refusal = await resetUserChoiceGate({ root, taskId: 'held', record: 'boundary', boundary: 'archive_gate', reason: 'x' })
            .catch((error: Error) => error.message);
        expect(String(refusal), 'the verb that refuses this shape still shows the road that runs').toMatch(/`rm .*archive_gate.json`/u);
        expect(readFileSync(target, 'utf8'), 'and the link is untouched by the refusal').toBe('{}\n');
    });

    it('answers the binding question the same way the one predicate does, for every state of the record', async () => {
        // **Round 9's F1: one fact, two answers.** The boundary record kind answered "yes, forever" for a record naming no
        // binding, while `verdict-binding.bindsToRevision` answered the same question "no" once a revision was sealed — and
        // no declared instrument decided the difference, so removing the gate's own early-return reddened nothing. The
        // obligation of that round is that one symbol answers it and that the gate, the reuse rule, the removal rule and
        // `assertRevision` all ask it. This case therefore compares the gate's answer with the predicate's state by state of
        // the record, rather than for the one state the repair happened to be about.
        const root = await fixture('binding-states');
        mkdirSync(join(root, 'src'), { recursive: true });
        writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
        const sealed = await createTaskRevisionIfChanged({ root, taskId: 'held', ownedPaths: ['src/a.ts'], checkIds: [] });
        const identity = await currentRevisionIdentity(root, 'held');
        expect(identity.manifestHash, 'the fixture is sealed, so the question is asked about sealed content')
            .toBe(sealed.revision.manifestHash);

        const states: Array<[string, { revisionId?: string; manifestHash?: string }]> = [
            ['names no binding at all', {}],
            ['names a revision the task has left', { revisionId: 'revision-the-task-has-left' }],
            ['names the sealed revision', { revisionId: sealed.revision.id }],
            ['names the sealed content', { manifestHash: sealed.revision.manifestHash }],
            ['names content that is not this content', { manifestHash: 'ff'.repeat(32) }],
        ];
        for (const [state, binding] of states) {
            const record = {
                taskId: 'held',
                boundary: 'review_gate',
                choice: 'continue_current',
                createdAt: new Date().toISOString(),
                approvedAt: new Date().toISOString(),
                ...binding,
            };
            writeFileSync(gatePath(root, 'review_gate'), `${JSON.stringify(record)}\n`);
            const speaks = bindsToRevision(record, identity, { scope: 'full' });
            const outcome = await requireUserChoiceGate({ root, taskId: 'held', boundary: 'review_gate' })
                .then(() => 'answered').catch(() => 'refused');
            expect(outcome, `the gate answers as the predicate does for a record that ${state}`).toBe(speaks ? 'answered' : 'refused');
        }
    });

    it('stops speaking for a record that names no binding once a revision is sealed, at the reuse rule and the removal rule', async () => {
        // **The two other readers of the same fact.** The states above go through `assertRevision`; the reuse rule reads a
        // task-level record and the removal rule reads either kind, and round 9 measured them answering "it speaks" while
        // `bindsToRevision` answered "it does not" — so the answer is asserted at all three, not only where the repair was.
        const root = await fixture('unbound-sealed');
        mkdirSync(join(root, 'src'), { recursive: true });
        writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
        await createTaskRevisionIfChanged({ root, taskId: 'held', ownedPaths: ['src/a.ts'], checkIds: [] });

        writeFileSync(gatePath(root, 'review_gate'), `${JSON.stringify({ taskId: 'held', boundary: 'review_gate', choice: 'continue_current', createdAt: new Date().toISOString(), approvedAt: new Date().toISOString() })}\n`);
        await expect(requireUserChoiceGate({ root, taskId: 'held', boundary: 'review_gate' }))
            .rejects.toThrow(/explicit user choice|no longer speaks/u);

        writeFileSync(taskChoicePath(root), `${JSON.stringify({ taskId: 'held', choice: 'switched', createdAt: new Date().toISOString(), approvedAt: new Date().toISOString() })}\n`);
        await expect(requireUserChoiceGate({ root, taskId: 'held', boundary: 'judge_gate' }))
            .rejects.toThrow(/explicit user choice/u);

        const reset = await resetUserChoiceGate({ root, taskId: 'held', record: 'boundary', boundary: 'review_gate', reason: 'the record names no content, so it is not a decision about this one' });
        expect(reset.removed, 'a record that names no content is not a live decision about sealed content').toBe(true);
    });

    it('reuses a task-level answer that predates the seal, bound to the declared content', async () => {
        // **C2's clause, and the other half of the same fact.** A record written before the first seal carries the digest of
        // the declared content — the same value the seal records — so it keeps speaking across the seal. Round 9's F5
        // measured that no declared instrument was aimed at this clause at all; this case is that instrument, and it also
        // holds the two derivations of that digest together (`computeManifestHash` here, `computeBothOwnedDigests` at the
        // seal), which is the only reason the sentence is true.
        const root = await fixture('declaration-bound');
        mkdirSync(join(root, 'src'), { recursive: true });
        writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
        await approveUserChoiceGate({ root, taskId: 'held', boundary: 'implementation_gate', choice: 'continue_current', forTask: true });
        const answered = JSON.parse(readFileSync(taskChoicePath(root), 'utf8')) as { manifestHash?: string };
        expect(answered.manifestHash, 'the pre-seal answer names the declared content').toMatch(/^[0-9a-f]{64}$/u);

        const sealed = await createTaskRevisionIfChanged({ root, taskId: 'held', ownedPaths: ['src/a.ts'], checkIds: [] });
        expect(answered.manifestHash, 'the declared digest is the digest the seal records, so the answer survives the seal')
            .toBe(sealed.revision.manifestHash);

        const reused = await requireUserChoiceGate({ root, taskId: 'held', boundary: 'review_gate' });
        expect(reused.choice).toBe('continue_current');
        expect(reused.reusedFromTaskChoice).toBe(true);
    });

    it('reads the current-revision pointer once per verb, however many readers ask the binding question', async () => {
        // **Round 9's F2.** The pointer is written non-atomically, so a second read inside one decision can answer
        // differently from the first and throw out of a gate that has already decided — `verdict-binding.ts` states that
        // contract for this file. The count is asserted because the two-read version is otherwise indistinguishable from
        // the one-read version, at the site the repair introduced and at the two verbs that cross the same boundary.
        const root = await fixture('one-read');
        mkdirSync(join(root, 'src'), { recursive: true });
        writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
        await createTaskRevisionIfChanged({ root, taskId: 'held', ownedPaths: ['src/a.ts'], checkIds: [] });
        await createUserChoiceGate({ root, taskId: 'held', boundary: 'review_gate' });

        pointerReads.count = 0;
        await approveUserChoiceGate({ root, taskId: 'held', boundary: 'review_gate', choice: 'continue_current' });
        expect(pointerReads.count, 'one approve reads the pointer once').toBe(1);

        pointerReads.count = 0;
        await requireUserChoiceGate({ root, taskId: 'held', boundary: 'review_gate' });
        expect(pointerReads.count, 'one require reads the pointer once').toBe(1);

        pointerReads.count = 0;
        await resetUserChoiceGate({ root, taskId: 'held', record: 'boundary', boundary: 'review_gate', reason: 'x' })
            .catch(() => undefined);
        expect(pointerReads.count, 'one reset reads the pointer once, whether or not it removes the record').toBe(1);
    });

    it('consumes the gate that admitted the command, not a re-asking of it after the command moved the content', async () => {
        // **The legacy "scoped at seal time" flow.** `design` creates the implementation gate while the task declares no
        // owned path, so the gate legitimately carries no binding; the operator answers it; then the command that follows
        // gives the task its content. Re-asking at consume time compared the admitted record against that new content and
        // refused a command that had already succeeded (measured through the CLI: `--owned-path` at seal time). The gate
        // the crossing admitted is the gate that is consumed.
        const root = await fixture('admitted-consume');
        mkdirSync(join(root, 'src'), { recursive: true });
        writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
        writeFileSync(gatePath(root, 'implementation_gate'), `${JSON.stringify({ taskId: 'held', boundary: 'implementation_gate', choice: 'continue_current', createdAt: new Date().toISOString(), approvedAt: new Date().toISOString() })}\n`);

        const admitted = await requireUserChoiceGate({ root, taskId: 'held', boundary: 'implementation_gate' });
        await createTaskRevisionIfChanged({ root, taskId: 'held', ownedPaths: ['src/a.ts'], checkIds: [] });

        await consumeUserChoiceGate({ root, taskId: 'held', boundary: 'implementation_gate', admitted });
        const consumed = JSON.parse(readFileSync(gatePath(root, 'implementation_gate'), 'utf8')) as { consumedAt?: string };
        expect(consumed.consumedAt, 'the admitted gate is the one recorded as consumed').toBeTruthy();

        // The same state consumed without an admission is refused: consuming is not a second asking of the boundary.
        writeFileSync(gatePath(root, 'judge_gate'), `${JSON.stringify({ taskId: 'held', boundary: 'judge_gate', choice: 'continue_current', createdAt: new Date().toISOString(), approvedAt: new Date().toISOString() })}\n`);
        await expect(consumeUserChoiceGate({ root, taskId: 'held', boundary: 'judge_gate' }))
            .rejects.toThrow(/no longer speaks|explicit user choice/u);
    });
});
