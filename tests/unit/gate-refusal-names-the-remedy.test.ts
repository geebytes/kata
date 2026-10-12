import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approveUserChoiceGate } from '../../src/workflow/user-choice-gate.js';
import { gateFixture, type GateFixture } from '../helpers/gate-fixture.js';

/**
 * **AC-3 — a refusal that says a gate cannot be used also says what to do about it.**
 *
 * A consumed gate is the *normal* state after a phase command succeeded, and the way forward is not guessable. The first
 * version of this case pinned "the command that recreates this boundary" — `kata-cli verify` for a consumed `review_gate`
 * — and that road is **refused in the state the refusal prints from**: a consumed `judge_gate` printed
 * `kata-cli review --approve`, which requires the phase to be `review` while a task whose `judge` succeeded sits in
 * `judge`, so the operator was sent to a closed door (measured, I-37; the task was unlocked by hand-writing the record).
 *
 * The contract is therefore the property rather than the sentence: a consumed boundary names the **next step**, from the
 * table that says what consumes each boundary, and that road runs where it is printed
 * (`tests/unit/a-gate-remedy-runs-where-it-is-printed.test.ts` sweeps the whole table for exactly that).
 */
describe('a refusal names the next step', () => {
    let fixture: GateFixture;

    beforeEach(async () => {
        fixture = await gateFixture('gate-remedy');
    });

    afterEach(async () => {
        await fixture.cleanup();
    });

    it('tells the operator how to rebuild a gate that was already consumed', async () => {
        await fixture.consumedGate();

        const refusal = await approveUserChoiceGate({
            root: fixture.root,
            taskId: fixture.taskId,
            boundary: 'review_gate',
            choice: 'continue_current',
        }).catch((error: Error) => error.message);

        expect(String(refusal)).toContain('already been consumed');
        // **The next step, not the creating command.** `verify` creates this boundary; the road out of a consumed one is
        // the step after it, and naming the creating command here would send the operator to a command that cannot help.
        expect(String(refusal)).toContain('kata-cli review');
        expect(String(refusal)).not.toContain('recreates this boundary');
    });
});
