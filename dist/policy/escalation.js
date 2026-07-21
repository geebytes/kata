export function shouldEscalate(event, policy) {
    if (event.kind === 'hard_failure') {
        const hardFailures = event.hardFailureCount ?? 0;
        if (hardFailures < policy.retryBudget) {
            return { escalate: false, reason: 'within_retry_budget' };
        }
        return escalate(event, policy, 'hard_failure_budget_exhausted');
    }
    if (event.kind === 'structured_output_failure')
        return escalate(event, policy, 'structured_output_failure');
    if (event.kind === 'source_conflict')
        return escalate(event, policy, 'source_conflict');
    if (event.kind === 'security_sensitive_scope')
        return escalate(event, policy, 'security_sensitive_scope');
    if (event.kind === 'budget_exceeded')
        return escalate(event, policy, 'budget_exceeded');
    return escalate(event, policy, 'ambiguous_acceptance');
}
function escalate(event, policy, reason) {
    const toTier = nextTier(policy.tier);
    if (!toTier)
        return { escalate: false, reason: 'already_frontier' };
    return {
        escalate: true,
        reason,
        fromTier: policy.tier,
        toTier,
        event,
    };
}
function nextTier(tier) {
    if (tier === 'economy')
        return 'capable';
    if (tier === 'capable')
        return 'frontier';
    return null;
}
