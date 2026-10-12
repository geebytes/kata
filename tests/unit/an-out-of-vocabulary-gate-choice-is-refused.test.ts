import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
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

    it('refuses it through the CLI too, and leaves the record unreadable-by-nobody', async () => {
        // The command is where the measured call was made, so the criterion is driven there as well: the CLI must not
        // report `approved: true` for a value it did not write.
        const root = await fixture('cli');
        await createUserChoiceGate({ root, taskId: 'held', boundary: 'archive_gate' });
        const cli = join(process.cwd(), 'dist', 'cli.js');
        if (!existsSync(cli)) return; // the bundle is built by the suite's own step; the writer cases above cover the rule
        let failed = false;
        try {
            execFileSync('node', [cli, 'gate', 'approve', '--task', 'held', '--boundary', 'archive_gate', '--choice', 'archive'], { cwd: root, stdio: 'pipe' });
        } catch {
            failed = true;
        }
        expect(failed).toBe(true);
        const written = JSON.parse(readFileSync(join(root, '.kata', 'tasks', 'held', 'user-choice-archive_gate.json'), 'utf8')) as { choice?: string };
        expect(written.choice).toBeUndefined();
    });
});
