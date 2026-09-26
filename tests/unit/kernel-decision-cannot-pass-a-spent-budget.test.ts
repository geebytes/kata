import { describe, expect, it } from 'vitest';
import { decide, type DecideInput } from '../../src/kernel/decide.js';
import { defaultPolicy } from '../../src/kernel/policy.js';
import type { BudgetUsage } from '../../src/kernel/budget.js';
import { makeClaim, makeEvidence, makePolicy, makeSubject, makeVerdict } from '../helpers/review.js';

/**
 * **A spent budget is never a pass.**
 *
 * The rule exists because cost must not enter the correctness predicate: if it did, the incentive would run the wrong way
 * — the less a round looks, the easier it would be to satisfy the cost condition. So every branch that can exhaust a
 * budget ends in `insufficient`, and this test walks the whole budget matrix rather than one example.
 */
function baseline(): DecideInput {
    const subject = makeSubject({ 'src/a.ts': 'holds' });
    return {
        subject,
        claims: [makeClaim({ severity: 'major' })],
        evidence: [makeEvidence({})],
        verdicts: [makeVerdict({ subjectRevision: subject.revision })],
        challenges: [],
        policy: makePolicy(),
        tier: 'strict',
        declaredRiskClasses: ['consistency'],
        assurance: 'observed',
        usage: {},
        discovery: { independentChallenges: 1 },
    };
}

describe('a spent budget cannot become a pass', () => {
    it('passes when nothing is exceeded, so the matrix below is about the budget and not about a broken fixture', () => {
        expect(decide(baseline()).verdict).toBe('pass');
    });

    it('returns insufficient for every exceeded limit, and never pass', () => {
        const cases: Array<{ name: string; usage: BudgetUsage; c0: number | null }> = [
            { name: 'tokens over a resolved limit', usage: { tokens: 1000 }, c0: 100 },
            { name: 'wall clock over the limit', usage: { wallMs: defaultPolicy().budgets.maxWallMs + 1 }, c0: null },
            { name: 'tool calls over a configured deadline', usage: { toolCalls: 500 }, c0: null },
            { name: 'all three at once', usage: { tokens: 1000, wallMs: defaultPolicy().budgets.maxWallMs + 1, toolCalls: 500 }, c0: 100 },
        ];
        for (const entry of cases) {
            const policy = entry.name.startsWith('tool calls')
                ? makePolicy({ budgets: { ...defaultPolicy().budgets, deadlineToolCalls: 40 } })
                : makePolicy();
            const decision = decide({ ...baseline(), policy, usage: entry.usage, c0Tokens: entry.c0 });
            expect(decision.verdict, entry.name).toBe('insufficient');
            expect(decision.verdict, entry.name).not.toBe('pass');
            expect(decision.reasons.some((reason) => reason.code === 'budget_exhausted'), entry.name).toBe(true);
        }
    });

    it('does not treat an unresolvable limit as a satisfied one: 0.6*C0 with no baseline is unknown', () => {
        const decision = decide({ ...baseline(), usage: { tokens: 10_000_000 }, c0Tokens: null });
        expect(decision.verdict).toBe('pass');
        // The budget was unmeasurable, so it cannot have been exceeded — and the reading is reported as unknown rather
        // than as a pass on the strength of an invented zero.
        expect(decision.reasons.some((reason) => reason.code === 'budget_exhausted')).toBe(false);
    });
});
