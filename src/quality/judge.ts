import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AcceptanceCriterion, AcceptanceMatrix } from '../core/task.js';
import type { EvidenceEnvelope } from './evidence.js';
import type { ReviewFinding } from './reviewer.js';
import { evaluateAcceptanceAdequacy } from './evidence-adequacy.js';
import { judgePath as layoutJudgePath, taskDir } from '../core/layout.js';

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
  // Phase 4 §1 returns this: an acceptance criterion with no matrix row cannot be evidenced structurally, and the
  // repair is to *declare* the row — which is Build's work, so it belongs in the repairable set.
  'no_acceptance_matrix_row',
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
  'no_acceptance_matrix_row',
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
  /**
   * Who owns the repair, for the scopes only a test can close.
   *
   * The repair-scope guide already tells a human where to go; this makes it machine-readable so the next action is
   * derived rather than inferred.
   */
  repairOwner?: 'build';
}

/** The scopes only a test (or its declaration) can close, so the repair belongs to Build. */
const buildOwnedRepairScopes: readonly RepairScope[] = [
  'missing_test_evidence',
  'insufficient_evidence_level',
  'no_acceptance_matrix_row',
];

/** The repair owner for a scope, or nothing when the scope is not Build's. */
export function repairOwnerFor(scope: RepairScope | undefined): 'build' | undefined {
  return scope !== undefined && buildOwnedRepairScopes.includes(scope) ? 'build' : undefined;
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
  // The ladder lives in quality/evidence-adequacy.ts, shared with the workflow's verify step. The Judge's own input is
  // the cross-revision refusal: a verdict over mixed revisions would be attached to neither of them.
  const adequacy = evaluateAcceptanceAdequacy({
    acceptance: input.acceptance,
    evidence: input.evidence,
    findings: input.findings,
    currentDiffHash: input.currentDiffHash,
    ...(input.currentScopeHashes ? { currentScopeHashes: input.currentScopeHashes } : {}),
    ...(input.matrix ? { matrix: input.matrix } : {}),
    ...(input.reviewMode ? { reviewMode: input.reviewMode } : {}),
    rejectCrossRevision: true,
  });
  const revisionIds = adequacy.revisionIds;
  const result: JudgeResult = {
    taskId: input.taskId,
    result: adequacy.acceptance.every((criterion) => criterion.result === 'PASS') ? 'PASS' : 'FAIL',
    diffHash: input.currentDiffHash,
    ...(revisionIds[0] ? { revisionId: revisionIds[0] } : {}),
    // L2-02: the Judge does not re-derive the match — one evaluator, one answer, which is why the ladder is shared
    // with verify. Each FAIL that only a test can close carries its repair owner.
    acceptance: adequacy.acceptance.map((criterion) => {
      const repairOwner = repairOwnerFor(criterion.repairScope);
      return repairOwner ? { ...criterion, repairOwner } : criterion;
    }),
    evidenceIds: adequacy.evidenceIds,
  };

  const root = input.root ?? process.cwd();
  // Stamped like every other verdict: the id names the revision, the manifest hash names the content it judged, so a
  // re-seal that changed nothing does not expire the judgement (see `workflow/verdict-binding.ts`).
  const { currentRevisionIdentity, revisionBindingFields } = await import('../workflow/verdict-binding.js');
  const binding = revisionBindingFields(await currentRevisionIdentity(root, input.taskId));
  await mkdir(taskDir(root, input.taskId), { recursive: true });
  await writeFile(
    layoutJudgePath(root, input.taskId),
    `${JSON.stringify({ ...result, ...binding }, null, 2)}\n`,
    'utf8',
  );

  return result;
}

