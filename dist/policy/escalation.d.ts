import type { ResolvedRolePolicy, Tier } from './model-policy.js';
export type EscalationEventKind = 'hard_failure' | 'structured_output_failure' | 'source_conflict' | 'security_sensitive_scope' | 'budget_exceeded' | 'ambiguous_acceptance';
export interface EscalationEvent {
    kind: EscalationEventKind;
    taskId: string;
    role: string;
    at: string;
    hardFailureCount?: number;
    details?: Record<string, string | number | boolean>;
}
export type EscalationReason = 'within_retry_budget' | 'hard_failure_budget_exhausted' | 'structured_output_failure' | 'source_conflict' | 'security_sensitive_scope' | 'budget_exceeded' | 'ambiguous_acceptance' | 'already_frontier';
export type EscalationDecision = {
    escalate: false;
    reason: 'within_retry_budget' | 'already_frontier';
} | {
    escalate: true;
    reason: Exclude<EscalationReason, 'within_retry_budget' | 'already_frontier'>;
    fromTier: Tier;
    toTier: Tier;
    event: EscalationEvent;
};
export declare function shouldEscalate(event: EscalationEvent, policy: ResolvedRolePolicy): EscalationDecision;
