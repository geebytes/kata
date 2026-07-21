import type { WikiRecord } from './record.js';
type LifecycleReason = 'source_changed' | 'source_missing' | 'semantic_superseded' | 'scope_changed' | 'conflict' | 'duplicate' | 'review_due' | 'candidate_over_budget';
type RecommendedAction = 'revalidate' | 'retire' | 'merge' | 'review_conflict' | 'review' | 'retire_duplicate';
export type WikiLifecycleAction = {
    id: string;
    status: WikiRecord['status'];
    reasons: LifecycleReason[];
    recommendedAction: RecommendedAction;
    confidence: 'low' | 'medium' | 'high';
    successorIds: string[];
    changedSources: string[];
};
export type WikiAudit = {
    generatedAt: string;
    pageCount: number;
    staleIds: string[];
    reviewDueIds: string[];
    duplicateGroups: string[][];
    overBudgetTasks: Array<{
        taskId: string;
        candidates: number;
        limit: number;
    }>;
    lintOk: boolean;
    lintIssues: number;
    recommendedActions: WikiLifecycleAction[];
};
export declare function auditWiki(root: string): Promise<WikiAudit>;
export declare function createRefreshPacket(root: string, taskId: string): Promise<{
    path: string;
    audit: WikiAudit;
}>;
export declare function relevantWiki(root: string, taskId: string, limit?: number): Promise<WikiRecord[]>;
export {};
//# sourceMappingURL=lifecycle.d.ts.map