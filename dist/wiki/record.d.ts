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
    createdAt: string;
    updatedAt: string;
    approvalEvent?: {
        approvedBy: string;
        role: string;
        approvedAt: string;
        notes?: string;
    };
    rejectionEvent?: {
        rejectedBy: string;
        role: string;
        rejectedAt: string;
        reason: string;
    };
}
export declare function computeFileHash(content: string): string;
export declare function validateWikiRecord(value: unknown): WikiRecord;
//# sourceMappingURL=record.d.ts.map