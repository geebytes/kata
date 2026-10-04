import { describe, expect, it } from 'vitest';
import {
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
      { kind: 'stalled_current_rounds', rounds: 4, noProgressRounds: 3, blockingIds: ['F-1'] },
      'escalate_review_without_progress',
      '/kata-review',
    ],
  ] as const)('routes %s by its assessment kind alone', (reviewLoop, reason, nextSkill) => {
    const action = suggestCandidateAction('review', summary(reviewLoop));

    expect(action).toMatchObject({ reason, nextSkill });
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
