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

    it('accepts only a conclusion bound to the packet and its compatible next action', () => {
        expect(validateRecurrenceAnalysis({
            triggerClasses: ['comparison-unnamed'],
            conclusion: 'instrument_unsound',
            evidence: ['.kata/tasks/example/review-rounds.jsonl:1-2'],
            nextAction: 'repair',
        }, packet)).toEqual({
            ok: true,
            analysis: {
                triggerClasses: ['comparison-unnamed'],
                conclusion: 'instrument_unsound',
                evidence: ['.kata/tasks/example/review-rounds.jsonl:1-2'],
                nextAction: 'repair',
            },
        });
    });
});
