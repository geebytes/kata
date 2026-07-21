const fallbackRetryBudget = 2;
const fallbackDiffBudget = { maxFiles: 4, maxLines: 200 };
export function resolveRolePolicy(role, config) {
    const roleConfig = config.roles?.[role];
    const tier = roleConfig?.tier ?? config.defaultTier;
    if (!config.tiers.includes(tier)) {
        throw new Error(`Tier ${tier} is not enabled for role ${role}`);
    }
    return {
        role,
        tier,
        retryBudget: roleConfig?.retryBudget ?? config.defaults?.retryBudget ?? config.repairLimit ?? fallbackRetryBudget,
        diffBudget: roleConfig?.diffBudget ?? config.defaults?.diffBudget ?? fallbackDiffBudget,
    };
}
export function resolveModelRoute(role, config, options = {}) {
    const rolePolicy = resolveRolePolicy(role, config);
    const modeName = options.routingMode ?? config.routingMode;
    const mode = modeName ? config.modes?.[modeName] : undefined;
    const taskPattern = options.taskKind ? config.taskPatterns?.[options.taskKind] : undefined;
    let tier = mode?.defaultTier ?? rolePolicy.tier;
    let reason = modeName ? `mode_${modeName}_default` : undefined;
    if (taskPattern && tierRank(taskPattern.tier) >= tierRank(tier)) {
        tier = taskPattern.tier;
        reason = taskPattern.reason ?? `task_kind_${options.taskKind}`;
    }
    if (rolePolicy.tier === 'frontier' && tier !== 'frontier') {
        tier = 'frontier';
        reason = 'role_minimum_tier';
    }
    else if (tierRank(rolePolicy.tier) > tierRank(tier) && role !== 'implementer') {
        tier = rolePolicy.tier;
        reason = 'role_minimum_tier';
    }
    if ((options.failureCount ?? 0) >= rolePolicy.retryBudget && tier !== 'frontier') {
        tier = 'frontier';
        reason = 'failure_count_escalation';
    }
    if (!config.tiers.includes(tier)) {
        throw new Error(`Tier ${tier} is not enabled for role ${role}`);
    }
    const route = config.routing?.[tier];
    if (!route) {
        throw new Error(`Model routing for tier ${tier} is required to resolve role ${role}`);
    }
    return {
        role,
        tier,
        provider: route.provider,
        model: route.model,
        ...(modeName ? { routingMode: modeName } : {}),
        ...(options.taskKind ? { taskKind: options.taskKind } : {}),
        reason,
        ...(route.costRatio !== undefined ? { costRatio: route.costRatio } : {}),
        ...(options.failureCount !== undefined ? { failureCount: options.failureCount } : {}),
        platformOptions: route.platformOptions ?? {},
    };
}
function tierRank(tier) {
    if (tier === 'economy')
        return 0;
    if (tier === 'capable')
        return 1;
    return 2;
}
export { shouldEscalate } from './escalation.js';
