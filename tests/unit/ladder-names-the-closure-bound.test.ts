import { describe, expect, it } from 'vitest';
import { nextActionReasons, suggestCandidateAction } from '../../src/workflow/navigation.js';

/**
 * **The round's conclusion criterion, after the class table was deleted with the old route.**
 *
 * The loop's measured shape is that findings per round *rise* rather than fall — `closure-gate` ran
 * `[7, 5, 5, 2, 5, 9, 10, 12, 14, 14]`, `kata-gate-surface` `[1, 8, 6, 6, 6, 7, 7, 10, 12, 13]` — because every repair is new
 * code and a round exists to find defects in new code. So "no findings" is unreachable and was never the right bound.
 *
 * The bound that could fail was *"every class an open finding names is covered by a check that reddens when the class
 * returns"*, computed by `roundClosure` and answered by `roundMayClose` over a hand-maintained class table. Both are gone:
 * the class table was deleted with the rest of the round-shaped route, `finding-lifecycle.ts` had no importer left, and the
 * ladder branch that consumed `roundClosure` could therefore never fire — nothing has written that field since.
 *
 * **A branch that cannot fire is worse than no branch**: a reader cannot tell a bound that was never reached from a bound
 * that no longer exists. What replaces it is the question the kernel can actually fail on — every risk class the tier's
 * contract requires must have a claim, and every claim must be supported — which `decide` enforces and the ladder routes
 * on through `satisfy_ledger_deficits`.
 */
describe('the closure bound the ladder names, after the class table was retired', () => {
    const base = {
        verifyResult: 'PASS',
        judgeResult: null,
        blockingFindings: 0,
        majorFindings: 0,
        minorFindings: 0,
        failingEvidence: 0,
        failedAcceptance: 0,
        reviewReady: true,
        reviewMode: 'std',
    } as never;

    it('does not route on a class table nobody maintains any more', () => {
        // The reason was in the vocabulary and was reachable only through a field with no producer. It is gone from both, so
        // an earlier-version caller cannot ask for a route the ladder no longer implements.
        expect(nextActionReasons as readonly string[]).not.toContain('cover_uncovered_classes');
    });

    it('moves on when the ledger has passed and the review has a conclusion', () => {
        const action = suggestCandidateAction('review', base);
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
        } as never);
        expect(action.reason).toBe('repair_blocking_review_findings');
    });

    it('routes a ledger that has not passed to its own deficits, which is the bound now', () => {
        // The question the class table used to ask is answered here: a change whose evidence does not support its claims, or
        // whose claims do not cover the tier's risk space, is repaired before anything else is considered.
        const action = suggestCandidateAction('review', {
            ...(base as Record<string, unknown>),
            ledger: { state: 'decided', verdict: 'insufficient', claims: 3, reason: 'claims are not supported', deficits: ['C1'] },
        } as never);
        expect(action.reason).toBe('satisfy_ledger_deficits');
    });
});
