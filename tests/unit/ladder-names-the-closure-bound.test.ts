import { describe, expect, it } from 'vitest';
import { suggestCandidateAction } from '../../src/workflow/navigation.js';

/**
 * **The round's conclusion criterion, in the ladder's vocabulary.**
 *
 * The loop's measured shape is that findings per round *rise* rather than fall — `closure-gate` ran `[7, 5, 5, 2, 5, 9, 10, 12, 14, 14]`,
 * `kata-gate-surface` `[1, 8, 6, 6, 6, 7, 7, 10, 12, 13]` — because every repair is new code and a round exists to find defects in new code.
 * So "no findings" is unreachable and was never the right bound. The bound that can actually fail is *"every class an open finding names is
 * covered by a check that reddens when the class returns"*, which `roundClosure` computes.
 *
 * Until this branch existed that verdict was only a field on `status`: the operator read it, and the ladder still sent the change back to
 * repair an instance of an already-covered class, one round at a time. Naming it as the next action is the difference between a bound that
 * is reported and a bound that is used.
 */
describe('the ladder names the closure bound when a round may not close', () => {
    const base = {
        verifyResult: 'PASS',
        judgeResult: null,
        blockingFindings: 0,
        majorFindings: 0,
        minorFindings: 0,
        unresolvedObligations: 0,
        failingEvidence: 0,
        failedAcceptance: 0,
        reviewReady: true,
        reviewMode: 'std',
    } as never;

    it('sends the reviewer to cover the class rather than repair one more instance', () => {
        const action = suggestCandidateAction('review', {
            ...(base as Record<string, unknown>),
            roundClosure: {
                mayClose: false,
                reason: 'classes with no covering check: one-concept-several-derivations',
                open: [{ classId: 'one-concept-several-derivations', covered: false }],
            },
        } as never);
        expect(action.reason).toBe('cover_uncovered_classes');
        expect(action.nextSkill).toBe('/kata-review');
    });

    it('does not fire when the round may close, so the ladder moves on', () => {
        // `reviewReady: true` and no closure verdict means the round is closed and the change advances — the branch is a bound, not a
        // detour: it exists to name what blocks the close, and it must not appear when nothing does.
        const action = suggestCandidateAction('review', base);
        expect(action.reason).not.toBe('cover_uncovered_classes');
        expect(action.reason).toBe('judge_reviewed_change');
    });

    it('does not fire while the review still has no conclusion to bind', () => {
        const action = suggestCandidateAction('review', { ...(base as Record<string, unknown>), reviewReady: false } as never);
        expect(action.reason).toBe('complete_review_conclusion');
    });

    it('does not overrule a real gate: an open blocking finding is still a repair', () => {
        const action = suggestCandidateAction('review', {
            ...(base as Record<string, unknown>),
            blockingFindings: 1,
            roundClosure: { mayClose: false, reason: 'classes with no covering check: x' },
        } as never);
        expect(action.reason).toBe('repair_blocking_review_findings');
    });

    it('does not overrule an unresolved obligation either', () => {
        const action = suggestCandidateAction('review', {
            ...(base as Record<string, unknown>),
            unresolvedObligations: 2,
            roundClosure: { mayClose: false, reason: 'classes with no covering check: x' },
        } as never);
        expect(action.reason).not.toBe('cover_uncovered_classes');
    });
});
