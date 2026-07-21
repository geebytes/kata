export type WikiClosureDecision = 'captured' | 'not_applicable' | 'deferred';
export interface WikiClosure {
    taskId: string;
    decision: WikiClosureDecision;
    reason: string;
    candidateIds: string[];
    updatedAt: string;
}
export type WikiClosureEvaluation = {
    valid: true;
    decision: 'captured' | 'not_applicable';
    closure: WikiClosure;
} | {
    valid: false;
    reason: 'missing' | 'deferred' | 'reason_required' | 'candidate_required' | 'candidate_missing';
    closure?: WikiClosure;
};
export declare function ensureWikiClosure(root: string, taskId: string): Promise<WikiClosure>;
export declare function readWikiClosure(root: string, taskId: string): Promise<WikiClosure | null>;
export declare function writeWikiClosure(root: string, taskId: string, input: {
    decision: WikiClosureDecision;
    reason: string;
    candidateIds?: string[];
}): Promise<WikiClosure>;
export declare function evaluateWikiClosure(root: string, taskId: string): Promise<WikiClosureEvaluation>;
//# sourceMappingURL=closure.d.ts.map