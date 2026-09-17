import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AcceptanceCriterion, AcceptanceMatrix } from '../core/task.js';
import { checkFreshness, type EvidenceEnvelope } from './evidence.js';
import type { ReviewFinding } from './reviewer.js';
import { getMatrixRowForAc, evidenceMatchesRow, isEntrypointEvidenceKind } from './acceptance-matrix.js';

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

/**
 * The repair vocabulary. Producers (this Judge, the verify evaluator) write `repairScope`; navigation, the
 * orchestrator, the repair gate and the installer's skill text read it. It is declared once, here, so a producer can
 * add a member and every consumer that maps it fails compilation until it decides what the new scope means.
 */
export const repairScopes = [
  'missing_test_evidence',
  'stale_evidence',
  'failing_evidence',
  'blocking_review_finding',
  'revision_superseded',
  'cross_revision_evidence',
  'insufficient_evidence_level',
  'unresolved_repair_obligation',
] as const;

export type RepairScope = (typeof repairScopes)[number];

/** Scopes a Judge FAIL may authorise repair for. */
export const repairableJudgeScopes = [
  'missing_test_evidence',
  'stale_evidence',
  'failing_evidence',
  'blocking_review_finding',
  'insufficient_evidence_level',
  'unresolved_repair_obligation',
] as const satisfies readonly RepairScope[];

/** Verify FAILs authorise drift repairs as well, which a Judge FAIL cannot. */
export const repairableVerifyScopes = [
  ...repairableJudgeScopes,
  'revision_superseded',
] as const satisfies readonly RepairScope[];

/** True when a failed acceptance carries a scope the given surface may authorise repair for. */
export function isRepairableScope(scope: RepairScope | undefined, allowed: readonly RepairScope[]): boolean {
  return scope !== undefined && allowed.includes(scope);
}

export interface JudgeAcceptanceResult {
  id: string;
  result: 'PASS' | 'FAIL';
  evidenceIds?: string[];
  repairScope?: RepairScope;
}

export interface JudgeResult {
  taskId: string;
  result: 'PASS' | 'FAIL';
  diffHash: string;
  revisionId?: string;
  acceptance: JudgeAcceptanceResult[];
  evidenceIds?: string[];
}

export async function judge(input: JudgeInput): Promise<JudgeResult> {
  const revisionIds = [...new Set(input.evidence.map((evidence) => evidence.revisionId).filter((id): id is string => Boolean(id)))];
  if (revisionIds.length > 1) {
    const result: JudgeResult = {
      taskId: input.taskId,
      result: 'FAIL',
      diffHash: input.currentDiffHash,
      acceptance: input.acceptance.map((criterion) => ({
        id: criterion.id ?? '', result: 'FAIL', repairScope: 'cross_revision_evidence',
      })),
    };
    const root = input.root ?? process.cwd();
    await mkdir(join(root, '.kata/tasks', input.taskId), { recursive: true });
    await writeFile(join(root, '.kata/tasks', input.taskId, 'judge.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    return result;
  }
  const freshEvidence = input.evidence.filter((evidence) => checkFreshness(
    evidence,
    input.currentDiffHash,
    input.currentScopeHashes?.get(evidence.id),
  ).fresh);
  const freshPassingTestEvidence = freshEvidence.filter((evidence) => evidence.kind === 'test' && evidence.exitCode === 0);
  const failingTestEvidence = freshEvidence.find((evidence) => evidence.kind === 'test' && evidence.exitCode !== 0);
  const blockingFindings = input.findings.filter((finding) => finding.severity === 'blocking'
    || (input.reviewMode === 'strict' && finding.severity === 'major'));

  const acceptance = input.acceptance.map((criterion): JudgeAcceptanceResult => {
    const acceptanceId = criterion.id ?? '';
    const blockingFinding = blockingFindings.find((finding) => !finding.acceptanceId || finding.acceptanceId === acceptanceId);
    if (failingTestEvidence) {
      return { id: acceptanceId, result: 'FAIL', repairScope: 'failing_evidence' };
    }
    if (freshPassingTestEvidence.length === 0 && input.evidence.some((evidence) => evidence.kind === 'test')) {
      return { id: acceptanceId, result: 'FAIL', repairScope: 'stale_evidence' };
    }
    if (freshPassingTestEvidence.length === 0) {
      return { id: acceptanceId, result: 'FAIL', repairScope: 'missing_test_evidence' };
    }
    if (input.matrix) {
      const row = getMatrixRowForAc(input.matrix, acceptanceId);
      if (row && isEntrypointEvidenceKind(row.verificationLevel)) {
        const hasRowSpecificEvidence = freshEvidence.some((item) => evidenceMatchesRow(row, item.command, item.kind));
        if (!hasRowSpecificEvidence) return { id: acceptanceId, result: 'FAIL', repairScope: 'insufficient_evidence_level' };
      }
    }
    if (blockingFinding) {
      return { id: acceptanceId, result: 'FAIL', repairScope: 'blocking_review_finding' };
    }
    return { id: acceptanceId, result: 'PASS', evidenceIds: freshPassingTestEvidence.map((evidence) => evidence.id) };
  });

  const result: JudgeResult = {
    taskId: input.taskId,
    result: acceptance.every((criterion) => criterion.result === 'PASS') ? 'PASS' : 'FAIL',
    diffHash: input.currentDiffHash,
    ...(revisionIds[0] ? { revisionId: revisionIds[0] } : {}),
    acceptance,
    evidenceIds: freshPassingTestEvidence.map((evidence) => evidence.id),
  };

  const root = input.root ?? process.cwd();
  await mkdir(join(root, '.kata/tasks', input.taskId), { recursive: true });
  await writeFile(join(root, '.kata/tasks', input.taskId, 'judge.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  return result;
}
