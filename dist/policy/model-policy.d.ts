export type Tier = 'economy' | 'capable' | 'frontier';
export type Role = string;
export interface DiffBudget {
    maxFiles: number;
    maxLines: number;
}
export interface RolePolicyConfig {
    tier?: Tier;
    retryBudget?: number;
    diffBudget?: DiffBudget;
}
export interface ModelRouteConfig {
    provider: string;
    model: string;
    costRatio?: number;
    platformOptions?: Record<string, Record<string, string>>;
}
export interface ModelRoutingModeConfig {
    defaultTier: Tier;
    description?: string;
}
export interface TaskPatternConfig {
    tier: Tier;
    reason?: string;
}
export interface ModelPolicy {
    defaultTier: Tier;
    tiers: Tier[];
    routingMode?: string;
    defaultSelection?: 'recommended' | 'current' | 'custom';
    repairLimit?: number;
    defaults?: {
        retryBudget?: number;
        diffBudget?: DiffBudget;
    };
    roles?: Record<Role, RolePolicyConfig>;
    routing?: Partial<Record<Tier, ModelRouteConfig>>;
    modes?: Record<string, ModelRoutingModeConfig>;
    taskPatterns?: Record<string, TaskPatternConfig>;
}
export interface ResolvedRolePolicy {
    role: Role;
    tier: Tier;
    retryBudget: number;
    diffBudget: DiffBudget;
}
export interface ResolvedModelRoute {
    role: Role;
    tier: Tier;
    provider: string;
    model: string;
    routingMode?: string;
    taskKind?: string;
    reason?: string;
    costRatio?: number;
    failureCount?: number;
    platformOptions: Record<string, Record<string, string>>;
}
export interface ResolveModelRouteOptions {
    routingMode?: string;
    taskKind?: string;
    failureCount?: number;
}
export declare function resolveRolePolicy(role: Role, config: ModelPolicy): ResolvedRolePolicy;
export declare function resolveModelRoute(role: Role, config: ModelPolicy, options?: ResolveModelRouteOptions): ResolvedModelRoute;
export { shouldEscalate, type EscalationDecision, type EscalationEvent } from './escalation.js';
