import type { Phase } from '../core/state.js';
import type { ReviewSeverity } from './reviewer.js';
import type { AcceptanceMatrix } from '../core/task.js';
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

/**
 * The declared repair scope: the matrix paths of the acceptance criteria a repair was authorized for.
 * A repair without recorded acceptance scopes (for example drift-authorized `revision_superseded` repairs)
 * yields no paths, and callers must not treat that as an empty diff.
 */
export function repairScopePaths(
    matrix: AcceptanceMatrix | undefined,
    scopeIds: readonly string[],
): string[] {
    const paths = new Set<string>();
    for (const scopeId of scopeIds) {
        const row = matrix?.rows.find((candidate) => candidate.acceptanceId === scopeId);
        if (!row) continue;
        for (const path of [...row.implementationPaths, ...row.testPaths]) paths.add(path);
    }
    return [...paths].sort();
}

/** Paths a repair touched outside its declared scope; empty when the repair stayed inside it. */
export function outOfScopeRepairPaths(
    taskId: string,
    changedPaths: readonly string[],
    allowedPaths: readonly string[],
): string[] {
    if (allowedPaths.length === 0) return [];
    const verdict = enforceRepairScope(
        { taskId, severity: 'blocking', relatedPaths: [...allowedPaths] },
        { changedPaths: [...changedPaths], filesChanged: changedPaths.length, linesChanged: 0 },
    );
    return verdict.allowed ? [] : [...(verdict.unrelatedPaths ?? [])];
}
