import type { AcceptanceCriterion, AcceptanceMatrix, AcceptanceMatrixRow } from '../core/task.js';
export interface MatrixValidationError {
    acceptanceId?: string;
    message: string;
}
export interface PathCoverageResult {
    missingImplementationPaths: string[];
    missingTestPaths: string[];
}
export interface CodeGraphCandidate {
    path: string;
    reason: string;
    sourcePaths: string[];
}
export type CodeGraphAffectedRunner = (root: string, sourcePaths: string[]) => Promise<string[]>;
export interface CodeGraphCandidateDisposition {
    evidenceCoveredCandidates: CodeGraphCandidate[];
    ownedCandidates: CodeGraphCandidate[];
    waivedCandidates: CodeGraphCandidate[];
    unresolvedCandidates: CodeGraphCandidate[];
}
export interface Waiver {
    path: string;
    reason: string;
    approvedBy: string;
    createdAt: string;
}
export declare function requiresMatrix(workflowProfile?: {
    strictClosure?: boolean;
    reviewMode?: string;
}): boolean;
export declare function validateMatrix(acceptance: AcceptanceCriterion[], matrix: AcceptanceMatrix | undefined): MatrixValidationError[];
export declare function isLegacyTask(matrix: AcceptanceMatrix | undefined): boolean;
export declare function getMatrixRowForAc(matrix: AcceptanceMatrix | undefined, acceptanceId: string): AcceptanceMatrixRow | undefined;
export declare function validatePathCoverage(matrix: AcceptanceMatrix | undefined, ownedPaths: string[]): PathCoverageResult;
export declare function pathOverlaps(owned: string, target: string): boolean;
export declare function isEntrypointEvidenceKind(kind: string): boolean;
export declare function hasRequiredEvidenceLevel(row: AcceptanceMatrixRow, evidenceKind: string): boolean;
export declare function evidenceMatchesRow(row: AcceptanceMatrixRow, evidenceCommand: string, evidenceKind: string): boolean;
export declare function discoverCodeGraphCandidates(root: string, matrix: AcceptanceMatrix, ownedPaths: string[], runAffected?: CodeGraphAffectedRunner): Promise<CodeGraphCandidate[]>;
export declare function classifyCodeGraphCandidates(matrix: AcceptanceMatrix, ownedPaths: string[], waivers: Waiver[], candidates: CodeGraphCandidate[]): CodeGraphCandidateDisposition;
export declare function readWaivers(root: string, taskId: string): Promise<Waiver[]>;
export declare function writeWaivers(root: string, taskId: string, waivers: Waiver[]): Promise<void>;
export declare function validateWaivers(waivers: Waiver[]): string[];
//# sourceMappingURL=acceptance-matrix.d.ts.map