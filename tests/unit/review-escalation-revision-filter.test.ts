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

  /**
   * **A line from another revision must not change the judgment about this one.**
   *
   * The filter above was applied to the loop but not to the aggregates: `rounds.length` still counted the whole file, so
   * the same current-revision history escalated with nothing else in the file and stopped escalating once one foreign
   * line was prefixed to it — the exact shape this change exists to remove, surviving one level up in the arithmetic.
   * Both directions are asserted, because "a foreign line is ignored" and "the current history is still judged" are two
   * facts and a fix that dropped the history entirely would satisfy only the first.
   */
  it('derives the same judgment whether or not a foreign line is present', () => {
    const mine = [round('1', 'revision-current', null), round('2', 'revision-current', null)];
    const withoutForeign = reviewProgress(mine, current);
    const withForeign = reviewProgress([round('0', 'revision-prior', null), ...mine], current);

    expect({ escalating: withForeign.escalating, unmeasurable: withForeign.unmeasurable, rounds: withForeign.rounds })
      .toEqual({ escalating: withoutForeign.escalating, unmeasurable: withoutForeign.unmeasurable, rounds: withoutForeign.rounds });
    // And the current history is still judged on its own terms: nothing measurable among *its* rounds is unmeasurable.
    expect(withoutForeign.unmeasurable).toBe(true);
    expect(withoutForeign.unmeasuredRounds).toBe(2);
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
