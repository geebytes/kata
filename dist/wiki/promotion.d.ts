import type { WikiRecord } from './record.js';
export interface ApprovalEvent {
    approvedBy: string;
    role: string;
    approvedAt: string;
    notes?: string;
}
export interface RejectionEvent {
    rejectedBy: string;
    role: string;
    rejectedAt: string;
    reason: string;
}
export declare function promote(root: string, id: string, approval: ApprovalEvent): Promise<WikiRecord>;
export declare function rejectCandidate(root: string, id: string, rejection: RejectionEvent): Promise<WikiRecord>;
export declare function retireWikiRecord(root: string, id: string, rejection: RejectionEvent): Promise<WikiRecord>;
//# sourceMappingURL=promotion.d.ts.map