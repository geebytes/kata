export type WikiStatus = 'candidate' | 'verified' | 'stale' | 'rejected';
export interface WikiRecord {
    id: string;
    statement: string;
    scope: string[];
    kind: string;
    sourceRefs: string[];
    sourceHashes: Record<string, string>;
    validationTaskId: string;
    evidenceIds: string[];
    status: WikiStatus;
    lastVerifiedAt: string;
}
export interface ContextRequest {
    root?: string;
    taskId: string;
    sourceRefs: string[];
}
export interface ExcludedWikiRecord {
    id: string;
    status: WikiStatus;
    reason: 'not-authoritative' | 'stale';
}
export interface ContextManifest {
    taskId: string;
    sourceRefs: string[];
    authoritativeWiki: WikiRecord[];
    excludedWiki: ExcludedWikiRecord[];
    warnings: string[];
}
export declare function buildContextManifest(input: ContextRequest): Promise<ContextManifest>;
//# sourceMappingURL=context.d.ts.map