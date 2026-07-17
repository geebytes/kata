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

export type RepairScopeResult =
  | {
      allowed: true;
      nextPhase: Extract<Phase, 'hardVerify'>;
    }
  | {
      allowed: false;
      reason: 'unrelated_repair_path' | 'diff_budget_exceeded';
      nextPhase: Extract<Phase, 'hardVerify'>;
      unrelatedPaths?: string[];
    };

export function enforceRepairScope(finding: Finding, diff: DiffSummary): RepairScopeResult {
  if (diff.budget && (diff.filesChanged > diff.budget.maxFiles || diff.linesChanged > diff.budget.maxLines)) {
    return { allowed: false, reason: 'diff_budget_exceeded', nextPhase: 'hardVerify' };
  }

  const relatedPaths = new Set(finding.relatedPaths.map(normalizePath));
  const unrelatedPaths = diff.changedPaths.map(normalizePath).filter((path) => !relatedPaths.has(path));
  if (unrelatedPaths.length > 0) {
    return {
      allowed: false,
      reason: 'unrelated_repair_path',
      unrelatedPaths,
      nextPhase: 'hardVerify',
    };
  }

  return { allowed: true, nextPhase: 'hardVerify' };
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\/+/, '');
}
