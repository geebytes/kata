import { describe, expect, it } from 'vitest';
import { recurrencePacketOfReadable, validateRecurrenceAnalysis } from '../../src/quality/recurrence-packet.js';

const packet = recurrencePacketOfReadable({
    kind: 'readable',
    rounds: [
        {
            at: '2026-10-11T00:00:00.000Z',
            revisionId: 'revision-one',
            blockingIds: ['R1-F1'],
            blockingCount: 1,
            findings: [{ id: 'R1-F1', severity: 'major', class: 'comparison-unnamed', origin: 'original' }],
        },
        {
            at: '2026-10-12T00:00:00.000Z',
            revisionId: 'revision-two',
            blockingIds: ['R2-F1'],
            blockingCount: 1,
            findings: [{ id: 'R2-F1', severity: 'major', class: 'comparison-unnamed', origin: 'repair' }],
        },
    ],
}, {
    reviewRounds: '.kata/tasks/example/review-rounds.jsonl',
    reviewHistory: '.kata/tasks/example/review-history.jsonl',
    currentReview: '.kata/tasks/example/review.json',
});

if (packet === null) throw new Error('fixture must activate the recurrence circuit breaker');

describe('a recurrence packet requires an attributable root-cause conclusion', () => {
    it('refuses an ordinary result, a conclusion for a different class, and an action that cannot address the cause', () => {
        expect(validateRecurrenceAnalysis(undefined, packet)).toMatchObject({ ok: false, why: expect.stringContaining('recurrenceAnalysis') });
        expect(validateRecurrenceAnalysis({
            triggerClasses: ['instrument-unsound'],
            conclusion: 'instrument_unsound',
            evidence: ['review-rounds.jsonl:2'],
            nextAction: 'repair',
        }, packet)).toMatchObject({ ok: false, why: expect.stringContaining('comparison-unnamed') });
        expect(validateRecurrenceAnalysis({
            triggerClasses: ['comparison-unnamed'],
            conclusion: 'claim_scope_error',
            evidence: ['review-rounds.jsonl:1-2'],
            nextAction: 'repair',
        }, packet)).toMatchObject({ ok: false, why: expect.stringContaining('restate_claim') });
    });

    it('accepts a conclusion bound to the packet, its compatible next action, and the closure it owes', () => {
        expect(validateRecurrenceAnalysis({
            triggerClasses: ['comparison-unnamed'],
            conclusion: 'instrument_unsound',
            evidence: ['.kata/tasks/example/review-rounds.jsonl:1-2'],
            nextAction: 'repair',
            closureObligation: {
                states: ['left boundary judged per code unit', 'left boundary judged per code point'],
                sourceOfTruth: 'precedingCharacter()',
                inventory: ['src/workflow/execution-sandbox.ts:198', 'src/workflow/execution-sandbox.ts:241'],
                invariant: 'an argument the operator wrote is never rewritten, whatever precedes the root',
                repairSurface: ['src/workflow/execution-sandbox.ts'],
                effectivenessTest: 'tests/unit/a-check-argument-is-not-rewritten-by-substring.test.ts',
                ifRecursAgain: 'rewrite_mechanism',
            },
        }, packet)).toEqual({
            ok: true,
            analysis: {
                triggerClasses: ['comparison-unnamed'],
                conclusion: 'instrument_unsound',
                evidence: ['.kata/tasks/example/review-rounds.jsonl:1-2'],
                nextAction: 'repair',
                closureObligation: {
                    states: ['left boundary judged per code unit', 'left boundary judged per code point'],
                    sourceOfTruth: 'precedingCharacter()',
                    inventory: ['src/workflow/execution-sandbox.ts:198', 'src/workflow/execution-sandbox.ts:241'],
                    invariant: 'an argument the operator wrote is never rewritten, whatever precedes the root',
                    repairSurface: ['src/workflow/execution-sandbox.ts'],
                    effectivenessTest: 'tests/unit/a-check-argument-is-not-rewritten-by-substring.test.ts',
                    ifRecursAgain: 'rewrite_mechanism',
                },
            },
        });
    });

    it('refuses a repair conclusion that owes a closure contract and does not carry one', () => {
        const checked = validateRecurrenceAnalysis({
            triggerClasses: ['comparison-unnamed'],
            conclusion: 'instrument_unsound',
            evidence: ['.kata/tasks/example/review-rounds.jsonl:1-2'],
            nextAction: 'repair',
        }, packet);

        expect(checked).toMatchObject({ ok: false });
        if (checked.ok) throw new Error('unreachable');
        expect(checked.problems).toHaveLength(1);
        expect(checked.problems[0]).toContain('closureObligation is required when nextAction is repair');
    });

    it('names every problem at once, so one round does not cost one mistake per submission', () => {
        const checked = validateRecurrenceAnalysis({
            triggerClasses: ['something-else'],
            conclusion: 'real_behaviour_defect',
            evidence: [],
            nextAction: 'repair',
            closureObligation: { states: [], sourceOfTruth: '', inventory: [], invariant: '', repairSurface: [], effectivenessTest: '', ifRecursAgain: 'repair' },
        }, packet);

        expect(checked).toMatchObject({ ok: false });
        if (checked.ok) throw new Error('unreachable');
        // The enum, the class list, the evidence, and every hollow field inside the obligation — in one answer.
        expect(checked.problems.length).toBeGreaterThanOrEqual(7);
        expect(checked.problems.join('; ')).toContain('conclusion must be one of');
        expect(checked.problems.join('; ')).toContain('triggerClasses must name exactly');
        expect(checked.problems.join('; ')).toContain('evidence must name at least one');
        expect(checked.problems.join('; ')).toContain('closureObligation.states must name');
        expect(checked.problems.join('; ')).toContain('closureObligation.sourceOfTruth must state');
        expect(checked.problems.join('; ')).toContain('closureObligation.ifRecursAgain must be one of');
    });

    it('refuses an obligation on a round that is not repairing: it would contract a repair that will not happen', () => {
        const checked = validateRecurrenceAnalysis({
            triggerClasses: ['comparison-unnamed'],
            conclusion: 'claim_scope_error',
            evidence: ['.kata/tasks/example/review-rounds.jsonl:1-2'],
            nextAction: 'restate_claim',
            closureObligation: {
                states: ['a'],
                sourceOfTruth: 'x',
                inventory: ['y'],
                invariant: 'z',
                repairSurface: ['p'],
                effectivenessTest: 't',
                ifRecursAgain: 'abandon_change',
            },
        }, packet);

        expect(checked).toMatchObject({ ok: false });
        if (checked.ok) throw new Error('unreachable');
        expect(checked.problems.join('; ')).toContain('only meaningful when nextAction is repair');
    });
});
