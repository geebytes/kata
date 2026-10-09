import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boundaryForCommand, recordsAConclusion, resultFileRequested, runWorkflowCommand } from '../../src/cli/workflow.js';
import { gateFixture, type GateFixture } from '../helpers/gate-fixture.js';

/**
 * **AC-1 — the closing command of the review ladder must be one the CLI can actually run.**
 *
 * `verify` → `gate approve` → `review --approve --review-evidence "…"` is the sequence the ladder prints and the sequence a
 * session performs to close a review. The second half was refused with `review_gate requires an explicit user choice`,
 * because the discriminator for "is this invocation *finishing* work inside a boundary it already crossed, or *opening*
 * it?" was read off one flag name: only `--result-file` counted as recording. So the approval — the other way a conclusion
 * is written down — demanded a gate the opening step had already consumed, and the only way past was to re-run `verify`
 * to rebuild the gate: a whole verification paid per close-out, for a discriminator that had the answer in hand.
 *
 * The controls matter as much as the fix: the invocation that *opens* the phase still asks for the gate, `--result-file`'s
 * existing exemption is untouched, and a bare `--approve` with no conclusion attached still crosses rather than records.
 */
describe('a recording approval is not a boundary crossing', () => {
    let fixture: GateFixture;

    beforeEach(async () => {
        fixture = await gateFixture('recording-approval');
    });

    afterEach(async () => {
        await fixture.cleanup();
    });

    it('reads the discriminator off what the invocation does, not off one flag name', () => {
        expect(recordsAConclusion(['review', '--approve', '--review-evidence', 'ledger decided pass'])).toBe(true);
        expect(recordsAConclusion(['review', '--review-evidence=ledger decided pass', '--approve'])).toBe(true);
        expect(recordsAConclusion(['review', '--result-file', 'tmp/round.json'])).toBe(true);

        // A bare approval conclusions nothing, so it is still a crossing; so is the invocation that opens the phase.
        expect(recordsAConclusion(['review', '--approve'])).toBe(false);
        expect(recordsAConclusion(['review'])).toBe(false);
        expect(recordsAConclusion(['review', '--approve', '--review-evidence', '   '])).toBe(false);
    });

    it('keeps `--result-file` exempt and the opening invocation asking, so the fix is not "recording means approval"', () => {
        expect(boundaryForCommand('review', 'review', { recording: resultFileRequested(['review', '--result-file', 'r.json']) })).toBeNull();
        expect(boundaryForCommand('review', 'review', { recording: recordsAConclusion(['review', '--approve', '--review-evidence', 'x']) })).toBeNull();

        expect(boundaryForCommand('review', 'review', { recording: recordsAConclusion(['review']) })).toBe('review_gate');
        expect(boundaryForCommand('review', 'hardVerify', { recording: recordsAConclusion(['review']) })).toBe('review_gate');
        expect(boundaryForCommand('review', 'review', { recording: recordsAConclusion(['review', '--approve']) })).toBe('review_gate');
    });

    it('approves after the gate was consumed, instead of demanding it a second time', async () => {
        await fixture.consumedGate();
        expect((await fixture.gate())?.consumedAt).toBeDefined();

        const approved = await runWorkflowCommand(
            'review',
            fixture.taskId,
            fixture.root,
            undefined,
            ['review', '--approve', '--review-evidence', 'the ledger decided pass and the round found nothing open'],
        ).catch((error: Error) => error.message);

        expect(String(approved)).not.toContain('requires an explicit user choice');
    });

    it('still refuses a bare approval against a consumed gate', async () => {
        await fixture.consumedGate();

        const refused = await runWorkflowCommand('review', fixture.taskId, fixture.root, undefined, ['review', '--approve'])
            .catch((error: Error) => error.message);

        expect(String(refused)).toContain('requires an explicit user choice');
    });
});
