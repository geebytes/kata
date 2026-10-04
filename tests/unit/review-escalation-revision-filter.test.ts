import { describe, expect, it } from 'vitest';
import { assessReviewLoop, type ReviewRound } from '../../src/quality/repair.js';

const current = { revisionId: 'revision-current', manifestHash: 'c'.repeat(64) };

function round(at: string, revisionId: string | undefined, blockingCount: number | null): ReviewRound {
  return {
    at,
    ...(revisionId ? { revisionId, manifestHash: revisionId === current.revisionId ? current.manifestHash : 'p'.repeat(64) } : {}),
    blockingIds: blockingCount === null ? [] : ['F-1'],
    blockingCount,
  };
}

function assess(rounds: ReviewRound[]) {
  return assessReviewLoop({
    currentRevision: { kind: 'current', identity: current },
    reviewRounds: { kind: 'readable', rounds },
  });
}

describe('review escalation revision filter', () => {
  it('does not derive a current escalation from prior-revision or legacy-unbound history', () => {
    const assessment = assess([
      round('1', 'revision-prior', null),
      round('2', undefined, null),
      round('3', 'revision-prior', null),
      round('4', undefined, null),
    ]);

    expect(assessment).toEqual({ kind: 'no_current_rounds' });
  });

  it('derives the same judgment whether or not a foreign line is present', () => {
    const mine = [round('1', 'revision-current', null), round('2', 'revision-current', null)];
    const withoutForeign = assess(mine);
    const withForeign = assess([round('0', 'revision-prior', null), ...mine]);

    expect(withForeign).toEqual(withoutForeign);
    expect(withoutForeign).toMatchObject({ kind: 'unmeasurable_current_rounds', rounds: 2 });
  });

  it('still escalates non-declining rounds bound to the current revision', () => {
    const assessment = assess([
      round('1', 'revision-current', 1),
      round('2', 'revision-current', 1),
      round('3', 'revision-current', 1),
      round('4', 'revision-current', 1),
    ]);

    expect(assessment).toMatchObject({ kind: 'stalled_current_rounds', noProgressRounds: 3 });
  });
});
