import type { AcceptanceCriterion, AcceptanceMatrix } from '../core/task.js';
import { type EvidenceEnvelope } from './evidence.js';
import type { ReviewFinding } from './reviewer.js';
export interface JudgeInput {
    root?: string;
    taskId: string;
    acceptance: AcceptanceCriterion[];
    evidence: EvidenceEnvelope[];
    findings: ReviewFinding[];
    currentDiffHash: string;
    currentScopeHashes?: Map<string, string>;
    proposedOutput?: unknown;
    matrix?: AcceptanceMatrix;
    reviewMode?: string;
}
export interface JudgeAcceptanceResult {
    id: string;
    result: 'PASS' | 'FAIL';
    evidenceIds?: string[];
    repairScope?: 'missing_test_evidence' | 'stale_evidence' | 'revision_superseded' | 'cross_revision_evidence' | 'failing_evidence' | 'blocking_review_finding' | 'insufficient_evidence_level' | 'unresolved_repair_obligation';
}
export interface JudgeResult {
    taskId: string;
    result: 'PASS' | 'FAIL';
    diffHash: string;
    revisionId?: string;
    acceptance: JudgeAcceptanceResult[];
    evidenceIds?: string[];
}
export declare function judge(input: JudgeInput): Promise<JudgeResult>;
//# sourceMappingURL=judge.d.ts.map