import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boundaryCreatedBy, createUserChoiceGate } from '../../src/workflow/user-choice-gate.js';
import { boundaryForCommand } from '../../src/cli/workflow.js';
import { gateFixture, type GateFixture } from '../helpers/gate-fixture.js';

/**
 * **AC-1 — a task sitting in `review` can re-enter it, with a gate it can use.**
 *
 * The reported deadlock had four links, all of them a surface keyed on a phase it assumed: the table of which command
 * *creates* a boundary, the phase a refusal *reports*, the remedy a refusal *names*, and the table of which command *asks
 * for* a boundary — that last one being where the reported project actually stopped, after the other three were fixed:
 * `verify` rebuilt the gate, `gate approve` accepted it, and `review --confirm-host-model` still refused, because
 * `boundaryForCommand('review', 'review')` answered `null` and the confirmation is derived from that boundary existing.
 */
describe('a task in review can re-enter it', () => {
    let fixture: GateFixture;

    beforeEach(async () => {
        fixture = await gateFixture();
    });

    afterEach(async () => {
        await fixture.cleanup();
    });

    it('creates the review gate for a successful verify whatever phase verify entered from', () => {
        expect(boundaryCreatedBy('hardVerify', 'verify')).toBe('review_gate');
        // **The line the deadlock came from.** A verify run from `review` reports `review`, and the table had no entry for
        // it — so the command every refusal tells an operator to run did nothing at all.
        expect(boundaryCreatedBy('review', 'verify')).toBe('review_gate');

        // Controls, so the fix is not "return review_gate for everything": the other boundaries keep their conditions.
        expect(boundaryCreatedBy('review', 'review', true)).toBe('judge_gate');
        expect(boundaryCreatedBy('review', 'review', false)).toBeNull();
        expect(boundaryCreatedBy('implement', 'build')).toBeNull();
        expect(boundaryCreatedBy('hardVerify', 'design')).toBeNull();
    });

    it('asks for its boundary in the phase it is already in, which is what the confirmation is derived from', () => {
        // `confirmHostModel` is `boundary !== null`: no boundary means no confirmation, which is why a task in `review`
        // refused with "requires explicit user confirmation" while holding a fresh, approved gate.
        expect(boundaryForCommand('review', 'hardVerify')).toBe('review_gate');
        expect(boundaryForCommand('review', 'review')).toBe('review_gate');
        expect(boundaryForCommand('judge', 'review')).toBe('judge_gate');
        expect(boundaryForCommand('judge', 'judge')).toBe('judge_gate');
        expect(boundaryForCommand('archive', 'archive')).toBe('archive_gate');
        expect(boundaryForCommand('build', 'plan')).toBe('implementation_gate');
        // The implementation choice belongs to `plan`; a task in `implement` has already made it.
        expect(boundaryForCommand('build', 'implement')).toBeNull();
        expect(boundaryForCommand('verify', 'review')).toBeNull();
    });

    it('replaces a consumed gate with a fresh one, and the fresh one can be answered', async () => {
        await fixture.consumedGate();
        expect((await fixture.gate())?.consumedAt).toBeDefined();

        // What the CLI does after a successful phase command: ask the table, then create.
        const boundary = boundaryCreatedBy('review', 'verify');
        expect(boundary).toBe('review_gate');
        await createUserChoiceGate({ root: fixture.root, taskId: fixture.taskId, boundary: boundary as 'review_gate' });

        const fresh = await fixture.gate();
        expect(fresh?.consumedAt).toBeUndefined();
        expect(fresh?.choice).toBeUndefined();
    });
});
