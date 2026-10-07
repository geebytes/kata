import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { gateFixture, type GateFixture } from '../helpers/gate-fixture.js';

/**
 * **AC-2 — a refusal reports the phase the task holds, not the phase the command assumed.**
 *
 * Reported from another checkout: the refusal said `phase=hardVerify` while `current-state.json` said `review`, so the
 * operator's next step — the remedy for a *stale* gate — was the wrong one. Every other return in `orchestrator.ts` reports
 * what it read (`cmdVerify` returns `phase: current.phase`); the review branch was the outlier.
 */
describe('a refusal reports the phase the task holds', () => {
    let fixture: GateFixture;

    beforeEach(async () => {
        fixture = await gateFixture('gate-phase');
    });

    afterEach(async () => {
        await fixture.cleanup();
    });

    it('reports review, not the phase the review command assumed', async () => {
        // A gate answered and not yet used: the command is allowed to reach its own confirmation check.
        await fixture.freshGate();

        const result = await runCommand('review', fixture.taskId, fixture.root);
        expect(result.success).toBe(false);
        expect(String(result.error)).toContain('confirmation');
        // The store says `review`; a hard-coded `hardVerify` here is what an operator would act on, and it is wrong.
        expect(result.phase).toBe('review');
    });
});
