import { describe, expect, it } from 'vitest';
import {
  nextActionForTask,
  suggestCandidateAction,
  type UpstreamSummary,
} from '../../src/workflow/navigation.js';
import type { ReviewLoopAssessment } from '../../src/quality/repair.js';

function summary(reviewLoop: ReviewLoopAssessment): UpstreamSummary {
  return {
    reviewFindings: 0,
    blockingFindings: 0,
    majorFindings: 0,
    failedAcceptance: 0,
    failedVerifyAcceptance: 0,
    repairScopes: [],
    verifyRepairScopes: [],
    evidenceFiles: [],
    failingEvidence: 0,
    reviewLoop,
  };
}

describe('review-loop routing contract', () => {
  it.each([
    [
      { kind: 'unreadable_current_revision', detail: 'invalid pointer' },
      'repair_unreadable_current_revision',
      '/kata-build',
    ],
    [
      { kind: 'unreadable_round_history', detail: 'invalid history' },
      'repair_unreadable_round_history',
      '/kata-build',
    ],
    [
      { kind: 'unmeasurable_current_rounds', rounds: 2, roundIds: ['r1', 'r2'] },
      'review_loop_unmeasurable',
      '/kata-review',
    ],
    [
      // **The escalation is terminal, and that is the pinned contract.** It used to route to `/kata-review`, so the state
      // named "the loop stopped making progress" bought the round that kept it going. Measured: eight rounds, seventy hours,
      // and every escalation dispatched another reviewer.
      { kind: 'stalled_current_rounds', rounds: 4, noProgressRounds: 3, blockingIds: ['F-1'] },
      'escalate_review_without_progress',
      '/kata',
    ],
  ] as const)('routes %s by its assessment kind alone', (reviewLoop, reason, nextSkill) => {
    const action = suggestCandidateAction('review', summary(reviewLoop));

    expect(action).toMatchObject({ reason, nextSkill });
  });

  it('stops the automatic loop: the escalation is a decision, not another dispatch', () => {
    const action = suggestCandidateAction('review', summary({ kind: 'stalled_current_rounds', rounds: 4, noProgressRounds: 3, blockingIds: ['F-1'] }));

    // `/kata` is the dispatcher's read-only status, so nothing continues on its own; the exits are enumerated for the owner.
    expect(action.nextSkill).toBe('/kata');
    expect(action.role).toBe('dispatcher');
    // The three exits are named by the action itself, from the shared vocabulary, so the surface and the requirement cannot
    // drift apart: rewrite the mechanism, waive with a named owner, or abandon the change — never "repair once more".
    const nextAction = nextActionForTask('example', action.nextSkill, action.role, action.reason);
    expect(nextAction.requiresUserConfirmation).toBe(true);
    expect(nextAction.escalationExits).toEqual(['rewrite_mechanism', 'waive_with_owner', 'abandon_change']);
    expect(nextAction.escalationExits).not.toContain('repair');
  });

  it('routes a stalled repair chain to the same terminal escalation, from the reading the revision cannot produce', () => {
    // Eight rounds, eight revisions: `reviewLoop` answers `no_current_rounds` for each new one, so the revision-scoped
    // escalation can never fire. The chain-scoped reading is what reaches the stop line.
    const stalledLineage = {
      ...summary({ kind: 'no_current_rounds' }),
      reviewLineage: { revisions: ['revision-a', 'revision-b', 'revision-c'], rounds: 3, noProgressRounds: 3, unmeasuredRounds: 0, stalled: true },
    };

    expect(suggestCandidateAction('review', stalledLineage)).toMatchObject({
      reason: 'escalate_review_without_progress',
      nextSkill: '/kata',
    });
  });

  it('does not escalate a chain that is still reducing its problems', () => {
    const progressing = {
      ...summary({ kind: 'no_current_rounds' }),
      reviewLineage: { revisions: ['revision-a', 'revision-b'], rounds: 2, noProgressRounds: 0, unmeasuredRounds: 0, stalled: false },
    };

    expect(suggestCandidateAction('review', progressing).reason).not.toBe('escalate_review_without_progress');
  });

  it.each([
    { kind: 'not_applicable', reason: 'no_current_revision' },
    { kind: 'no_current_rounds' },
    { kind: 'progressing_current_rounds', rounds: 2, noProgressRounds: 1 },
  ] as const)('does not let non-terminal %s override normal routing', (reviewLoop) => {
    expect(suggestCandidateAction('review', summary(reviewLoop)).reason)
      .not.toMatch(/^(repair_unreadable_|review_loop_unmeasurable|escalate_review_without_progress)/);
  });
});
