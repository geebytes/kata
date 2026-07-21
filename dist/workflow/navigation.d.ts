import type { Phase } from '../core/state.js';
export type UpstreamSummary = {
    currentRevisionId?: string;
    reviewFindings: number;
    blockingFindings: number;
    majorFindings: number;
    reviewMode?: string;
    judgeResult?: string;
    verifyResult?: string;
    failedAcceptance: number;
    failedVerifyAcceptance: number;
    repairScopes: string[];
    verifyRepairScopes: string[];
    wikiClosureValid?: boolean;
    wikiClosureReason?: string;
    evidenceFiles: string[];
    failingEvidence: number;
    unresolvedObligations: number;
    unresolvedObligationAcIds: string[];
    missingAcceptanceMatrix?: boolean;
    mixedRevisionEvidence?: boolean;
};
export type SuggestedAction = {
    nextSkill: string;
    role: string;
    reason: string;
    priority: number;
    acceptanceIds?: string[];
};
export type NextAction = {
    taskId: string;
    nextSkill: string;
    slashCommand: string;
    cliCommand: string;
    role: string;
    reason: string;
    requiresUserConfirmation: boolean;
    modelOrPlatformSwitchAllowed: boolean;
    trustBoundary?: 'implementation_gate' | 'review_gate' | 'judge_gate' | 'archive_gate';
    pauseInstruction?: string;
};
export declare function readUpstreamSummary(root: string, taskId: string): Promise<UpstreamSummary>;
export declare function suggestCandidateAction(phase: string, upstream: UpstreamSummary): SuggestedAction;
export declare function nextSkillForPhase(phase: Phase): string;
export declare function nextActionForTask(taskId: string, nextSkill: string, role: string, reason: string): NextAction;
export declare function statusActionPrompts(suggestion: {
    nextSkill: string;
    reason: string;
    role: string;
    acceptanceIds?: string[];
}): string[];
//# sourceMappingURL=navigation.d.ts.map