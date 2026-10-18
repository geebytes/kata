import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTask } from '../../src/core/task.js';
import { initLayout } from '../../src/core/layout.js';
import { createUserChoiceGate, USER_CHOICES, approveUserChoiceGate } from '../../src/workflow/user-choice-gate.js';

/**
 * AC-1 — a gate choice that is not in the vocabulary is refused by name, and nothing is written.
 *
 * The measured deadlock (I-36): `kata-cli gate approve --boundary archive_gate --choice archive` returned
 * `{"approved":true}` and wrote `user-choice-archive_gate.json`, whose `choice` the schema rejects — so from then on
 * **every** read of that record failed (`$.choice must be one of …`), `gate approve` refused, `archive` refused
 * ("requires an explicit user choice"), deleting the file did not help (a missing file is an error to the reader, not
 * "no gate"), and no command removed or rewrote it. The task was deadlocked until the record was restored by hand.
 *
 * The asymmetry is the defect: the reader validated and the writer did not. The criterion is therefore the pair — an
 * illegal value is refused **and** the record on disk is untouched — plus the control that the legal values still work,
 * because a writer that refuses everything would satisfy the first half and be useless.
 */
const roots: string[] = [];

async function fixture(name: string): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), `kata-gate-choice-${name}-`));
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

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('an out-of-vocabulary gate choice is refused', () => {
    it('refuses the value the schema rejects, by name, and writes nothing', async () => {
        const root = await fixture('refused');
        await createUserChoiceGate({ root, taskId: 'held', boundary: 'archive_gate' });
        const path = join(root, '.kata', 'tasks', 'held', 'user-choice-archive_gate.json');
        const before = readFileSync(path, 'utf8');

        await expect(approveUserChoiceGate({ root, taskId: 'held', boundary: 'archive_gate', choice: 'archive' as never }))
            .rejects.toThrow(/archive/u);

        // The refusal names what is accepted, so the operator is not left to guess.
        await expect(approveUserChoiceGate({ root, taskId: 'held', boundary: 'archive_gate', choice: 'nonsense' as never }))
            .rejects.toThrow(new RegExp(USER_CHOICES.join('|'), 'u'));
        // **And nothing was written.** The record is byte-identical to what the creation wrote, so the state that
        // deadlocked the task cannot be produced.
        expect(readFileSync(path, 'utf8')).toBe(before);
        expect(before).not.toContain('"choice"');
    });

    it('still approves every legal value, so the refusal is a vocabulary and not a wall', async () => {
        const root = await fixture('legal');
        for (const choice of USER_CHOICES) {
            await createUserChoiceGate({ root, taskId: 'held', boundary: 'review_gate' });
            await approveUserChoiceGate({ root, taskId: 'held', boundary: 'review_gate', choice });
            const written = JSON.parse(readFileSync(join(root, '.kata', 'tasks', 'held', 'user-choice-review_gate.json'), 'utf8')) as { choice?: string };
            expect(written.choice).toBe(choice);
        }
    });

    it('lists the same choices the gate schema allows, so neither side can drift', async () => {
        // **The writer's vocabulary and the reader's are two artefacts.** The first version of this selector iterated a fixed
        // illegal list and round-tripped the writer's own values through the reader, which catches a writer *narrower* than
        // the schema and misses a writer *wider* than it — the direction that produced the deadlock (measured by the first
        // round). Reading both is what makes the comparison real.
        const schema = JSON.parse(readFileSync(join(process.cwd(), 'schemas', 'user-choice-gate.schema.json'), 'utf8')) as {
            properties: { choice: { enum: string[] } };
        };
        expect([...USER_CHOICES].sort()).toEqual([...schema.properties.choice.enum].sort());
        // And the task-choice record carries the same vocabulary, since a reused choice is materialised into a gate record.
        const taskChoice = JSON.parse(readFileSync(join(process.cwd(), 'schemas', 'task-choice.schema.json'), 'utf8')) as {
            properties: { choice: { enum: string[] } };
        };
        expect([...USER_CHOICES].sort()).toEqual([...taskChoice.properties.choice.enum].sort());
    });

    it('materialises the task-level choice into a record its own reader accepts', async () => {
        // **The reuse path is a second writer of the gate record, and its record was unreadable.** It writes
        // `reusedFromTaskChoice` (the audit trail for "this boundary reused the task choice"), a field the gate schema did
        // not list while `additionalProperties` is false — so the record it produced failed the schema its own reader
        // enforces, which is the round-1 blocking finding. This case is that finding's instrument: it materialises the
        // record and reads it back through the reader, so removing the field from the schema reddens it.
        const root = await fixture('reuse');
        mkdirSync(join(root, '.kata', 'tasks', 'held'), { recursive: true });
        // **Recorded by the mechanism, not by hand** (round 7's F2): a task-level answer that carries no binding is no longer
        // reused, because an answer about unknown content must not authorise the content under consideration. The property
        // this case decides — the reuse path materialises a record its own reader accepts — is unchanged.
        const { requireUserChoiceGate, readGateState, recordTaskChoice } = await import('../../src/workflow/user-choice-gate.js');
        await recordTaskChoice({ root, taskId: 'held', choice: 'switched' });
        const reused = await requireUserChoiceGate({ root, taskId: 'held', boundary: 'review_gate' });
        expect(reused.choice).toBe('switched');
        expect(reused.reusedFromTaskChoice).toBe(true);
        // Read back: the record on disk is usable, not damaged.
        const state = await readGateState(root, 'held', 'review_gate');
        expect(state.kind).toBe('usable');
        // And a task-choice record that cannot be read is named as damaged rather than answered with "no choice yet".
        writeFileSync(join(root, '.kata', 'tasks', 'held', 'user-choice-task.json'), '{"taskId": "held", "choice": "archive"}\n');
        await expect(requireUserChoiceGate({ root, taskId: 'held', boundary: 'judge_gate' })).rejects.toThrow(/damaged/u);
    });

    it('refuses a boundary name that is not one of the four, so a cast cannot reach a path', async () => {
        // **The reset verb cast the boundary and built a path from it.** `--boundary ../../src/a` cancelled the first
        // segment of `path.join(taskDir, 'user-choice-' + boundary + '.json')` and `rm` removed whatever it resolved to
        // (measured by the first round, a path traversal out of a read-only-looking command). The vocabulary is enforced
        // where the path is built, so every reader and writer is covered by the one check.
        const root = await fixture('boundary');
        const { resetUserChoiceGate, readGateState } = await import('../../src/workflow/user-choice-gate.js');
        const outside = join(root, 'src');
        mkdirSync(outside, { recursive: true });
        writeFileSync(join(outside, 'a.json'), '{}\n');

        await expect(resetUserChoiceGate({ root, taskId: 'held', record: 'boundary', boundary: '../../src/a' as never, reason: 'x' })).rejects.toThrow(/Unknown gate boundary/u);
        expect(existsSync(join(outside, 'a.json'))).toBe(true);
        await expect(readGateState(root, 'held', '../held/user-choice-archive_gate' as never)).rejects.toThrow(/Unknown gate boundary/u);
    });

    it('refuses the same vocabulary the reader validates, so the two cannot drift', async () => {
        // **The write side and the read side ask one value.** The deadlock came from their asymmetry; this asserts the
        // shape of the fix rather than the message: every value the writer refuses must also be refused by the reader,
        // and every value it accepts must be readable back.
        const root = await fixture('one-vocabulary');
        const illegal = ['archive', 'continue', 'CONTINUE_CURRENT', '', ' switched'];
        for (const value of illegal) {
            await createUserChoiceGate({ root, taskId: 'held', boundary: 'implementation_gate' });
            await expect(approveUserChoiceGate({ root, taskId: 'held', boundary: 'implementation_gate', choice: value as never })).rejects.toThrow();
        }
        for (const value of USER_CHOICES) {
            await createUserChoiceGate({ root, taskId: 'held', boundary: 'implementation_gate' });
            await approveUserChoiceGate({ root, taskId: 'held', boundary: 'implementation_gate', choice: value });
            // Read back through the same reader the gates use.
            const { requireUserChoiceGate } = await import('../../src/workflow/user-choice-gate.js');
            expect((await requireUserChoiceGate({ root, taskId: 'held', boundary: 'implementation_gate' })).choice).toBe(value);
        }
    });

    it('refuses an out-of-vocabulary value at the task-level writer as well', async () => {
        // **Round 8's F8.** The task-level writer stored whatever it was given, so it could write a record its own reader
        // reports as damaged — the second writer of the same fact needs the same check as the first.
        const root = await fixture('task-choice-vocabulary');
        const { recordTaskChoice } = await import('../../src/workflow/user-choice-gate.js');
        await expect(recordTaskChoice({ root, taskId: 'held', choice: 'archive' as never })).rejects.toThrow(/refuses the choice "archive"/u);
    });
});
