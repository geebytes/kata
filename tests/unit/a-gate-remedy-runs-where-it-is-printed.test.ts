import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTask } from '../../src/core/task.js';
import { initLayout } from '../../src/core/layout.js';
import { GATE_CONSUMED_BY, GATE_CREATED_BY, approveUserChoiceGate, createUserChoiceGate, gateConsumedInstruction, gateRebuildInstruction } from '../../src/workflow/user-choice-gate.js';

/**
 * AC-3 — every boundary's remedy runs in the phase that prints it.
 *
 * The measured state (I-37): a `judge_gate` that had been consumed printed `Run \`kata-cli review --approve\` … then
 * approve it again`, and `review --approve` requires the phase to be `review` — while a task whose `judge` succeeded sits
 * in `judge`. `gate approve` refuses a consumed gate, `judge` refuses without a fresh choice, and the printed remedy is
 * inert in exactly the state that printed it: three roads, all closed. The task was unlocked by hand-writing the record.
 *
 * The criterion is the property, not the sentence: for every boundary, the road printed in the state the refusal fires in
 * must be one the CLI accepts **there** — and the table that says which command consumes a boundary must exist for every
 * boundary, so a boundary added without a road is red.
 */
const roots: string[] = [];

async function fixture(name: string): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), `kata-gate-remedy-${name}-`));
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

/** Mark a gate consumed without running a phase command, so the refusal can be driven in one fixture. */
function consume(root: string, boundary: string): void {
    const path = gatePath(root, boundary);
    const record = JSON.parse(execFileSync('node', ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(path)}, 'utf8'))`], { encoding: 'utf8' })) as Record<string, unknown>;
    writeFileSync(path, `${JSON.stringify({ ...record, choice: 'continue_current', approvedAt: new Date().toISOString(), consumedAt: new Date().toISOString() }, null, 2)}\n`);
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('a gate remedy runs where it is printed', () => {
    it('has a consumed-by entry for every boundary, so a new boundary cannot arrive without a road', () => {
        // The table check. `GATE_CREATED_BY` said how each gate is made; nothing said what consumes it, so the refusal for
        // a consumed gate had to guess a road — and guessed one that is refused in that state.
        for (const boundary of Object.keys(GATE_CREATED_BY)) {
            expect(GATE_CONSUMED_BY, boundary).toHaveProperty(boundary);
            expect(GATE_CONSUMED_BY[boundary as keyof typeof GATE_CONSUMED_BY].command.length, boundary).toBeGreaterThan(0);
        }
    });

    it('does not name the creating command as the road for a gate that was already consumed', async () => {
        // **The measured case.** After `judge` succeeded, the judge gate is consumed and the task is in `judge`; the old
        // sentence named `review --approve`, which refuses in that phase. The refusal must not send the operator to a road
        // that is closed where it is printed.
        const root = await fixture('consumed');
        await createUserChoiceGate({ root, taskId: 'held', boundary: 'judge_gate' });
        consume(root, 'judge_gate');

        let message = '';
        try {
            await approveUserChoiceGate({ root, taskId: 'held', boundary: 'judge_gate', choice: 'continue_current' });
        } catch (error) {
            message = (error as Error).message;
        }
        expect(message).toMatch(/consumed/u);
        expect(message).not.toMatch(/review --approve/u);
        expect(gateConsumedInstruction('judge_gate')).not.toMatch(/review --approve/u);
    });

    it('states the consumer, the next boundary and where that boundary gets its gate — from its own tables', () => {
        // **The first version of this case asked only whether the CLI knew the verb** — and an independent round measured a
        // mutation that replaced a road with `kata-cli archive` (a verb the CLI knows and refuses from phase `review`) and
        // left it green: an instrument that cannot redden for the property it names. The properties here are read from the
        // tables, so a table that loses an entry, or a row whose `next` names a boundary with no creating entry, is red.
        for (const boundary of Object.keys(GATE_CREATED_BY) as Array<keyof typeof GATE_CREATED_BY>) {
            const entry = GATE_CONSUMED_BY[boundary];
            const instruction = gateConsumedInstruction(boundary);
            // The consumer is stated, from the table.
            expect(instruction, boundary).toContain(entry.command);
            if (entry.next === undefined) {
                // The last boundary says so rather than promising a step that does not exist.
                expect(instruction, boundary).toMatch(/ladder ends/u);
                continue;
            }
            // The next boundary is named, and it has a creating entry — so the ladder this sentence describes is total.
            expect(instruction, boundary).toContain(entry.next);
            const created = GATE_CREATED_BY[entry.next];
            expect(created, `${boundary} -> ${entry.next}`).toBeDefined();
            const creator = entry.next === 'judge_gate' ? 'kata-cli review --approve' : `kata-cli ${created.command}`;
            expect(instruction, boundary).toContain(creator);
            // And the phase is stated whenever the table has one, because that is what makes the sentence checkable.
            if (created.phase !== undefined) expect(instruction, boundary).toContain(created.phase);
        }
    });

    it('does not claim a road runs now: it states what happened and where the next gate comes from', async () => {
        // The sentence the first round measured as inert named `kata-cli archive` for a consumed `judge_gate`, and `archive`
        // is refused from phase `judge` because its own gate is not approved. The instruction therefore contains no promise
        // about what will run; this asserts the shape rather than the wording.
        const instruction = gateConsumedInstruction('judge_gate');
        expect(instruction).not.toMatch(/Continue with/u);
        expect(instruction).toMatch(/already crossed/u);
        expect(instruction).toMatch(/archive_gate/u);
        // The rebuild sentence names the phase its command runs in, so a boundary whose entry has no phase says so.
        expect(gateRebuildInstruction('judge_gate')).toContain('review');
        expect(gateRebuildInstruction('implementation_gate')).toContain('plan');
    });

    it('says the state instead of asking for a decision that was already made', async () => {
        const root = await fixture('state');
        await createUserChoiceGate({ root, taskId: 'held', boundary: 'review_gate' });
        consume(root, 'review_gate');
        let message = '';
        try {
            await approveUserChoiceGate({ root, taskId: 'held', boundary: 'review_gate', choice: 'continue_current' });
        } catch (error) {
            message = (error as Error).message;
        }
        // The state, and the command that consumed it — so the operator can see what happened rather than only that
        // something did.
        expect(message).toMatch(/kata-cli review/u);
        expect(message).toMatch(/continue|next|proceed/iu);
    });
});
