import type { Phase } from '../core/state.js';
import type { ReviewSeverity } from './reviewer.js';
export interface Finding {
    taskId: string;
    acceptanceId?: string;
    severity: ReviewSeverity;
    relatedPaths: string[];
}
export interface DiffBudget {
    maxFiles: number;
    maxLines: number;
}
export interface DiffSummary {
    changedPaths: string[];
    filesChanged: number;
    linesChanged: number;
    budget?: DiffBudget;
}
export type RepairScopeResult = {
    allowed: true;
    nextPhase: Extract<Phase, 'hardVerify'>;
} | {
    allowed: false;
    reason: 'unrelated_repair_path' | 'diff_budget_exceeded';
    nextPhase: Extract<Phase, 'hardVerify'>;
    unrelatedPaths?: string[];
};
export declare function enforceRepairScope(finding: Finding, diff: DiffSummary): RepairScopeResult;
//# sourceMappingURL=repair.d.ts.map