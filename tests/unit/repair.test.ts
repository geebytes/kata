import { describe, expect, it } from 'vitest';
import { enforceRepairScope, outOfScopeRepairPaths, repairScopePaths, type DiffSummary, type Finding } from '../../src/quality/repair.js';

describe('bounded repair scope', () => {
  it('accepts repair diffs that only touch paths related to the failing acceptance criterion', () => {
    const finding: Finding = {
      taskId: 'task-5',
      acceptanceId: 'AC-2',
      severity: 'blocking',
      relatedPaths: ['src/policy/model-policy.ts', 'tests/unit/model-policy.test.ts'],
    };
    const diff: DiffSummary = {
      changedPaths: ['src/policy/model-policy.ts', 'tests/unit/model-policy.test.ts'],
      filesChanged: 2,
      linesChanged: 60,
    };

    expect(enforceRepairScope(finding, diff)).toEqual({
      allowed: true,
      nextPhase: 'hardVerify',
    });
  });

  it('rejects unrelated repair paths and still directs the loop back to hardVerify', () => {
    const finding: Finding = {
      taskId: 'task-5',
      acceptanceId: 'AC-2',
      severity: 'blocking',
      relatedPaths: ['src/policy/model-policy.ts'],
    };
    const diff: DiffSummary = {
      changedPaths: ['src/policy/model-policy.ts', 'src/adapters/codex.ts'],
      filesChanged: 2,
      linesChanged: 45,
    };

    expect(enforceRepairScope(finding, diff)).toEqual({
      allowed: false,
      reason: 'unrelated_repair_path',
      unrelatedPaths: ['src/adapters/codex.ts'],
      nextPhase: 'hardVerify',
    });
  });

  it('rejects repair diffs that exceed the provided diff budget', () => {
    const finding: Finding = {
      taskId: 'task-5',
      acceptanceId: 'AC-2',
      severity: 'blocking',
      relatedPaths: ['src/quality/repair.ts'],
    };
    const diff: DiffSummary = {
      changedPaths: ['src/quality/repair.ts'],
      filesChanged: 1,
      linesChanged: 121,
      budget: { maxFiles: 1, maxLines: 120 },
    };

    expect(enforceRepairScope(finding, diff)).toEqual({
      allowed: false,
      reason: 'diff_budget_exceeded',
      nextPhase: 'hardVerify',
    });
  });

  describe('scope derived from the acceptance matrix', () => {
    const matrix = {
      version: 1 as const,
      rows: [
        {
          acceptanceId: 'AC-1',
          implementationPaths: ['src/quality/repair.ts'],
          testPaths: ['tests/unit/repair.test.ts'],
          evidence: [{ kind: 'test' as const, command: 'vitest run' }],
          verificationLevel: 'unit' as const,
        },
        {
          acceptanceId: 'AC-2',
          implementationPaths: ['src/eval/runner.ts'],
          testPaths: ['tests/unit/eval-metrics.test.ts'],
          evidence: [{ kind: 'test' as const, command: 'vitest run' }],
          verificationLevel: 'unit' as const,
        },
      ],
    };

    it('collects the implementation and test paths of the repaired acceptance criteria', () => {
      expect(repairScopePaths(matrix, ['AC-1'])).toEqual(['src/quality/repair.ts', 'tests/unit/repair.test.ts']);
      expect(repairScopePaths(matrix, ['AC-2', 'AC-1'])).toEqual([
        'src/eval/runner.ts',
        'src/quality/repair.ts',
        'tests/unit/eval-metrics.test.ts',
        'tests/unit/repair.test.ts',
      ]);
    });

    it('yields no scope for unknown criteria or drift-authorized repairs', () => {
      expect(repairScopePaths(matrix, ['AC-9'])).toEqual([]);
      expect(repairScopePaths(matrix, [])).toEqual([]);
      expect(repairScopePaths(undefined, ['AC-1'])).toEqual([]);
    });

    it('reports the changed paths that fall outside the repaired scope', () => {
      const allowed = repairScopePaths(matrix, ['AC-1']);
      expect(outOfScopeRepairPaths('task-5', ['src/quality/repair.ts'], allowed)).toEqual([]);
      expect(outOfScopeRepairPaths('task-5', ['src/quality/repair.ts', 'src/eval/runner.ts'], allowed))
        .toEqual(['src/eval/runner.ts']);
      // A repair without a declared scope never blocks: there is nothing to exceed.
      expect(outOfScopeRepairPaths('task-5', ['src/eval/runner.ts'], [])).toEqual([]);
    });
  });
});
