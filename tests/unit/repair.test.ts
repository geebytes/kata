import { describe, expect, it } from 'vitest';
import { enforceRepairScope, type DiffSummary, type Finding } from '../../src/quality/repair.js';

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
});
