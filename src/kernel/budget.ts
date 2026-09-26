/**
 * Budget — a scheduling input, never a correctness condition.
 *
 * The rule the external review named and this module enforces: a spent budget must not become a pass. If cost entered the
 * correctness predicate the incentive would run the wrong way — the less a round looks, the easier it passes. So the
 * budget decides *who reviews and how much*, and an exhausted budget can only return `insufficient`.
 *
 * A limit that cannot be resolved against the recorded baseline is reported as unmeasured, never as zero: "0.6*C0" with
 * no `C0` is not a limit of zero, it is a limit nobody knows.
 */
import type { Policy } from './policy.js';

export type BudgetUsage = {
    tokens?: number | null;
    wallMs?: number | null;
    toolCalls?: number | null;
};

export type BudgetExceeded = { limit: 'tokens' | 'wallMs' | 'toolCalls'; used: number; allowed: number };

export type BudgetStatus = {
    exhausted: boolean;
    exceeded: BudgetExceeded[];
    resolvedTokenLimit: number | null;
    /** True when an expression limit could not be resolved, so the budget is unknown rather than satisfied. */
    tokenLimitUnresolved: boolean;
};

/** `0.6*C0` against a recorded baseline; an unparseable expression resolves to null (unknown, not zero). */
export function resolveTokenBudget(policy: Policy, c0Tokens: number | null): number | null {
    const value = policy.budgets.maxTokensPerChange;
    if (typeof value === 'number') return value;
    const match = /^([0-9]*\.?[0-9]+)\s*\*\s*C0$/u.exec(value.trim());
    if (!match) return null;
    if (c0Tokens === null) return null;
    const factor = Number(match[1]);
    if (!Number.isFinite(factor)) return null;
    return factor * c0Tokens;
}

export function budgetStatus(input: {
    policy: Policy;
    usage: BudgetUsage;
    c0Tokens?: number | null;
}): BudgetStatus {
    const tokenLimit = resolveTokenBudget(input.policy, input.c0Tokens ?? null);
    const exceeded: BudgetExceeded[] = [];
    if (tokenLimit !== null && typeof input.usage.tokens === 'number' && input.usage.tokens > tokenLimit) {
        exceeded.push({ limit: 'tokens', used: input.usage.tokens, allowed: tokenLimit });
    }
    const wallLimit = input.policy.budgets.maxWallMs;
    if (typeof input.usage.wallMs === 'number' && input.usage.wallMs > wallLimit) {
        exceeded.push({ limit: 'wallMs', used: input.usage.wallMs, allowed: wallLimit });
    }
    const toolLimit = input.policy.budgets.deadlineToolCalls;
    if (toolLimit !== null && typeof input.usage.toolCalls === 'number' && input.usage.toolCalls > toolLimit) {
        exceeded.push({ limit: 'toolCalls', used: input.usage.toolCalls, allowed: toolLimit });
    }
    return {
        exhausted: exceeded.length > 0,
        exceeded,
        resolvedTokenLimit: tokenLimit,
        tokenLimitUnresolved: tokenLimit === null,
    };
}

export function budgetDetail(status: BudgetStatus): string {
    if (status.exceeded.length > 0) {
        return status.exceeded
            .map((entry) => `${entry.limit} used ${entry.used} against ${entry.allowed}`)
            .join('; ');
    }
    return status.tokenLimitUnresolved
        ? 'the budget could not be resolved against a recorded baseline, so it is unknown rather than satisfied'
        : 'the budget was not exceeded';
}
