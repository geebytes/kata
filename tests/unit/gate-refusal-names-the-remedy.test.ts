import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approveUserChoiceGate } from '../../src/workflow/user-choice-gate.js';
import { gateFixture, type GateFixture } from '../helpers/gate-fixture.js';

/**
 * **AC-3 — a refusal that says a gate cannot be used also says what to do about it.**
 *
 * A consumed gate is the *normal* state after a phase command succeeded, and the way forward is not guessable: the gate has
 * to be recreated, by the command whose success creates this boundary. The stale-revision branch already printed that
 * sentence; the consumed branch printed "has already been consumed" and stopped, which is what the reported operator had to
 * act on.
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
        // The command that recreates this boundary, from the same table the creation path reads.
        expect(String(refusal)).toContain('kata-cli verify');
    });
});
