import { describe, expect, it } from 'vitest';
import {
  assessReviewLoop,
  type ReviewLoopAssessmentInput,
  type ReviewRound,
} from '../../src/quality/repair.js';

const current = { revisionId: 'revision-current', manifestHash: 'c'.repeat(64) };

function round(
  at: string,
  revisionId: string | undefined,
  blockingCount: number | null,
): ReviewRound {
  return {
    at,
    ...(revisionId
      ? {
          revisionId,
          manifestHash: revisionId === current.revisionId ? current.manifestHash : 'p'.repeat(64),
        }
      : {}),
    blockingIds: blockingCount === null ? [] : ['F-1'],
    blockingCount,
  };
}

function input(
  rounds: ReviewRound[],
  overrides: Partial<ReviewLoopAssessmentInput> = {},
): ReviewLoopAssessmentInput {
  return {
    currentRevision: { kind: 'current', identity: current },
    reviewRounds: { kind: 'readable', rounds },
    ...overrides,
  };
}

describe('review-loop assessment', () => {
  it('treats legacy and foreign rounds as audit-only for the current revision', () => {
    const currentRounds = [
      round('1', current.revisionId, 1),
      round('2', current.revisionId, 1),
      round('3', current.revisionId, 1),
      round('4', current.revisionId, 1),
    ];

    const baseline = assessReviewLoop(input(currentRounds));
    const withForeignHistory = assessReviewLoop(input([
      round('legacy', undefined, null),
      round('foreign', 'revision-prior', 99),
      ...currentRounds,
    ]));

    expect(baseline).toEqual({
      kind: 'stalled_current_rounds',
      rounds: 4,
      noProgressRounds: 3,
      blockingIds: ['F-1'],
    });
    expect(withForeignHistory).toEqual(baseline);
  });

  it('names an unreadable current revision instead of judging another revision history', () => {
    const assessment = assessReviewLoop(input(
      [
        round('1', 'revision-prior', 1),
        round('2', 'revision-prior', 1),
        round('3', 'revision-prior', 1),
        round('4', 'revision-prior', 1),
      ],
      { currentRevision: { kind: 'unreadable', detail: 'invalid current-revision.json' } },
    ));

    expect(assessment).toEqual({
      kind: 'unreadable_current_revision',
      detail: 'invalid current-revision.json',
    });
  });

  it('names unreadable history instead of emitting a zero-count escalation', () => {
    const assessment = assessReviewLoop(input([], {
      reviewRounds: { kind: 'unreadable', rounds: [], detail: 'malformed JSONL' },
    }));

    expect(assessment).toEqual({ kind: 'unreadable_round_history', detail: 'malformed JSONL' });
  });

  it.each([
    [
      'absent identity',
      input([], { currentRevision: { kind: 'absent' } }),
      { kind: 'not_applicable', reason: 'no_current_revision' },
    ],
    [
      'no current rounds',
      input([round('foreign', 'revision-prior', 1)]),
      { kind: 'no_current_rounds' },
    ],
    [
      'current unmeasurable rounds',
      input([round('1', current.revisionId, null), round('2', current.revisionId, null)]),
      { kind: 'unmeasurable_current_rounds', rounds: 2, roundIds: ['1', '2'] },
    ],
    [
      'current progressing rounds',
      input([round('1', current.revisionId, 2), round('2', current.revisionId, 1)]),
      { kind: 'progressing_current_rounds', rounds: 2, noProgressRounds: 0 },
    ],
  ] as const)('classifies %s exclusively', (_name, assessmentInput, expected) => {
    expect(assessReviewLoop(assessmentInput)).toEqual(expected);
  });
});
