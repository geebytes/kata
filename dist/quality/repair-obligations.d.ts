import type { AcceptanceMatrix } from '../core/task.js';
import type { EvidenceEnvelope } from './evidence.js';
export interface RepairObligation {
    id: string;
    taskId: string;
    source: 'review' | 'judge';
    findingId?: string;
    acceptanceId?: string;
    severity: 'blocking';
    message: string;
    createdAt: string;
    resolvedAt?: string;
    resolvedByRevisionId?: string;
    resolvedEvidenceIds?: string[];
}
export interface ObligationRecord {
    obligations: RepairObligation[];
    updatedAt: string;
}
export declare function readObligations(root: string, taskId: string): Promise<RepairObligation[]>;
export declare function hasUnresolvedObligations(root: string, taskId: string): Promise<boolean>;
export declare function persistBlockingFindings(root: string, taskId: string, findings: Array<{
    id: string;
    acceptanceId?: string;
    severity: string;
    message: string;
}>): Promise<RepairObligation[]>;
export declare function persistBlockingJudgeResult(root: string, taskId: string, acceptanceResults: Array<{
    id: string;
    result: string;
}>): Promise<RepairObligation[]>;
export declare function resolveObligationsForRevision(root: string, taskId: string, revisionId: string, resolvedAcceptanceIds: string[], evidenceIds: string[], matrix?: AcceptanceMatrix, evidence?: EvidenceEnvelope[]): Promise<RepairObligation[]>;
export declare function reopenObligation(root: string, taskId: string, obligationId: string): Promise<boolean>;
//# sourceMappingURL=repair-obligations.d.ts.map