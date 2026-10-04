import { describe, expect, it } from 'vitest';
import { reviewProgress, type ReviewRound } from '../../src/quality/repair.js';

const current = { revisionId: 'revision-current', manifestHash: 'c'.repeat(64) };

function round(at: string, revisionId: string | undefined, blockingCount: number | null): ReviewRound {
  return {
    at,
    ...(revisionId ? { revisionId, manifestHash: revisionId === 'revision-current' ? current.manifestHash : 'p'.repeat(64) } : {}),
    blockingIds: blockingCount === null ? [] : ['F-1'],
    blockingCount,
  };
}

describe('review escalation revision filter', () => {
  it('does not derive a current escalation from prior-revision or legacy-unbound history', () => {
    const progress = reviewProgress([
      round('1', 'revision-prior', null),
      round('2', undefined, null),
      round('3', 'revision-prior', null),
      round('4', undefined, null),
    ], current);

    expect(progress).toMatchObject({ escalating: false, unmeasuredRounds: 0, noProgressRounds: 0 });
  });

  it('still escalates non-declining rounds bound to the current revision', () => {
    const progress = reviewProgress([
      round('1', 'revision-current', 1),
      round('2', 'revision-current', 1),
      round('3', 'revision-current', 1),
      round('4', 'revision-current', 1),
    ], current);

    expect(progress.escalating).toBe(true);
  });
});
