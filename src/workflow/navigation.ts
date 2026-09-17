import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Phase } from '../core/state.js';
import { evaluateWikiClosure } from '../wiki/closure.js';
import { readObligations } from '../quality/repair-obligations.js';
import type { RepairScope } from '../quality/judge.js';
import { reviewPath, judgePath, verifyPath, taskPath, evidenceDir as layoutEvidenceDir } from '../core/layout.js';
import { readCurrentTaskRevision } from './revision.js';
import { bindsToRevision } from './verdict-binding.js';

export type UpstreamSummary = {
  currentRevisionId?: string;
  reviewFindings: number;
  blockingFindings: number;
  majorFindings: number;
  reviewMode?: string;
  reviewReady?: boolean;
  invalidReviewApproval?: boolean;
  judgeResult?: string;
  verifyResult?: string;
  failedAcceptance: number;
  failedVerifyAcceptance: number;
  repairScopes: RepairScope[];
  verifyRepairScopes: RepairScope[];
  wikiClosureValid?: boolean;
  wikiClosureReason?: string;
  evidenceFiles: string[];
  failingEvidence: number;
  unresolvedObligations: number;
  unresolvedObligationAcIds: string[];
  missingAcceptanceMatrix?: boolean;
  mixedRevisionEvidence?: boolean;
};

/**
 * Every reason a next action can carry. The field is part of the CLI's public JSON and drives the trust-boundary
 * decision below, so producers pass a member of this union rather than a loose string.
 */
export const nextActionReasons = [
  'add_entrypoint_evidence',
  'adversarial_review_pending',
  'adversarial_verify_pending',
  'archive_judged_change',
  'archived_task',
  'choose_execution_mode',
  'complete_review_conclusion',
  'continue_implementation',
  'design_intake_task',
  'git_flow_confirmation_required',
  'inspect_task',
  'invalid_review_approval',
  'judge_reviewed_change',
  'migrate_legacy_acceptance_matrix',
  'rebuild_stale_evidence',
  'rebuild_superseded_revision',
  'repair_blocking_review_findings',
  'repair_failed_judge',
  'repair_failed_verify',
  'repair_failing_evidence',
  'repair_mixed_revision_evidence',
  'repair_strict_major_findings',
  'repair_unresolved_obligations',
  'resolve_repair_obligations',
  'resolve_wiki_closure',
  'review_fresh_implementation',
  'verify_fresh_implementation',
] as const;

export type NextActionReason = (typeof nextActionReasons)[number];

export type TrustBoundary = 'implementation_gate' | 'review_gate' | 'judge_gate' | 'archive_gate';

/**
 * The reason a repair carries when every failed acceptance shares one scope. `null` means the caller's own default
 * applies. A `Record` over the whole vocabulary so a new scope has to decide this.
 */
export const reasonForUniformScope: Record<RepairScope, NextActionReason | null> = {
  revision_superseded: 'rebuild_superseded_revision',
  stale_evidence: 'rebuild_stale_evidence',
  insufficient_evidence_level: 'add_entrypoint_evidence',
  unresolved_repair_obligation: 'resolve_repair_obligations',
  missing_test_evidence: null,
  failing_evidence: null,
  blocking_review_finding: null,
  cross_revision_evidence: null,
};

/** The scopes that a uniform failed set can map to a specific reason, or `null` when they are mixed or unmapped. */
export function uniformScopeReason(scopes: readonly RepairScope[]): NextActionReason | null {
  if (scopes.length === 0) return null;
  const [first] = scopes;
  if (!scopes.every((scope) => scope === first)) return null;
  return reasonForUniformScope[first as RepairScope] ?? null;
}

export type SuggestedAction = {
  nextSkill: string;
  role: string;
  reason: NextActionReason;
  priority: number;
  acceptanceIds?: string[];
};

export type NextAction = {
  taskId: string;
  nextSkill: string;
  slashCommand: string;
  cliCommand: string;
  role: string;
  reason: NextActionReason;
  requiresUserConfirmation: boolean;
  modelOrPlatformSwitchAllowed: boolean;
  trustBoundary?: TrustBoundary;
  pauseInstruction?: string;
};

export async function readUpstreamSummary(root: string, taskId: string): Promise<UpstreamSummary> {
  const evidenceFiles = await listEvidenceFiles(root, taskId);
  const evidence = await Promise.all(evidenceFiles.map((file) => readJsonFile<{ exitCode?: number; revisionId?: string }>(join(layoutEvidenceDir(root), file))));
  const revisionIds = [...new Set(evidence.map((item) => item?.revisionId).filter((id): id is string => Boolean(id)))];
  const mixedRevision = revisionIds.length > 1;
  const currentRevisionId = revisionIds.length === 1 ? revisionIds[0] : undefined;
  // The sealed content, so a verdict that named the previous id but reviewed the same bytes still counts.
  const sealed = await readCurrentTaskRevision(root, taskId);
  const binding = { revisionId: currentRevisionId ?? '', manifestHash: sealed?.manifestHash ?? null };
  const review = currentRevisionId && !mixedRevision
    ? onlyCurrentRevision(await readJsonFile<{ revisionId?: string; manifestHash?: string; status?: string; reviewEvidence?: string; findings?: Array<{ severity?: string }> }>(reviewPath(root, taskId)), binding)
    : !mixedRevision ? await readJsonFile<{ status?: string; reviewEvidence?: string; findings?: Array<{ severity?: string }> }>(reviewPath(root, taskId)) : null;
  const findings = review?.findings ?? [];
  const invalidReviewApproval = review?.status === 'approved' && !review.reviewEvidence?.trim();
  const judge = currentRevisionId && !mixedRevision
    ? onlyCurrentRevision(await readJsonFile<{ revisionId?: string; manifestHash?: string; result?: string; acceptance?: Array<{ result?: string; repairScope?: string }> }>(judgePath(root, taskId)), binding)
    : !mixedRevision ? await readJsonFile<{ result?: string; acceptance?: Array<{ result?: string; repairScope?: string }> }>(judgePath(root, taskId)) : null;
  const failedAcceptance = judge?.acceptance?.filter((item) => item.result === 'FAIL') ?? [];
  const verify = currentRevisionId && !mixedRevision
    ? onlyCurrentRevision(await readJsonFile<{ revisionId?: string; manifestHash?: string; result?: string; acceptance?: Array<{ result?: string; repairScope?: string }> }>(verifyPath(root, taskId)), binding)
    : !mixedRevision ? await readJsonFile<{ result?: string; acceptance?: Array<{ result?: string; repairScope?: string }> }>(verifyPath(root, taskId)) : null;
  const failedVerifyAcceptance = verify?.acceptance?.filter((item) => item.result === 'FAIL') ?? [];
  const wikiClosure = await evaluateWikiClosure(root, taskId);
  const obligations = await readObligations(root, taskId);
  const unresolvedObligations = obligations.filter((o) => !o.resolvedAt);
  const task = await readJsonFile<{ acceptanceMatrix?: unknown; workflowProfile?: { reviewMode?: string } }>(taskPath(root, taskId));
  const reviewMode = task?.workflowProfile?.reviewMode;
  return {
    ...(currentRevisionId ? { currentRevisionId } : {}),
    reviewFindings: findings.length,
    blockingFindings: findings.filter((finding) => finding.severity === 'blocking').length,
    majorFindings: findings.filter((finding) => finding.severity === 'major').length,
    ...(reviewMode ? { reviewMode } : {}),
    reviewReady: review?.status === 'approved' && Boolean(review.reviewEvidence?.trim()),
    ...(invalidReviewApproval ? { invalidReviewApproval: true } : {}),
    ...(judge?.result ? { judgeResult: judge.result } : {}),
    ...(verify?.result ? { verifyResult: verify.result } : {}),
    failedAcceptance: failedAcceptance.length,
    failedVerifyAcceptance: failedVerifyAcceptance.length,
    repairScopes: failedAcceptance.map((item) => item.repairScope).filter((scope): scope is RepairScope => Boolean(scope)),
    verifyRepairScopes: failedVerifyAcceptance.map((item) => item.repairScope).filter((scope): scope is RepairScope => Boolean(scope)),
    wikiClosureValid: wikiClosure.valid,
    ...(!wikiClosure.valid ? { wikiClosureReason: wikiClosure.reason } : {}),
    evidenceFiles,
    failingEvidence: evidence.filter((item) => item && typeof item.exitCode === 'number' && item.exitCode !== 0).length,
    unresolvedObligations: unresolvedObligations.length,
    unresolvedObligationAcIds: [...new Set(unresolvedObligations.map((o) => o.acceptanceId).filter((id): id is string => Boolean(id)))],
    ...(task && !task.acceptanceMatrix ? { missingAcceptanceMatrix: true } : {}),
    ...(mixedRevision ? { mixedRevisionEvidence: true } : {}),
  };
}

function revisionIdForEvidence(evidence: Array<{ revisionId?: string } | null>): string | undefined {
  const revisionIds = [...new Set(evidence.map((item) => item?.revisionId).filter((id): id is string => Boolean(id)))];
  return revisionIds.length === 1 ? revisionIds[0] : undefined;
}

/**
 * Keeps a verdict that speaks for the current revision — by id, or by the content it reviewed.
 *
 * The content half matters for the same reason it does everywhere else: a re-seal of unchanged owned paths issues a new
 * revision id, and a reader that only knows the id reports "no verdict" for a verdict that is still exactly right.
 */
function onlyCurrentRevision<T extends { revisionId?: string; manifestHash?: string }>(
  artifact: T | null,
  current: { revisionId: string; manifestHash?: string | null },
): T | null {
  return artifact && bindsToRevision(artifact, { revisionId: current.revisionId, manifestHash: current.manifestHash ?? null })
    ? artifact
    : null;
}

/**
 * Who may be active while a task is in each phase. The platform hook guard enforces exactly this, and the CLI activates
 * the hook with it; a task in `plan` is activated as its designer, not as the implementer it will become.
 */
export const activeRoleByPhase: Record<Phase, string> = {
  intake: 'designer',
  plan: 'designer',
  implement: 'implementer',
  hardVerify: 'reviewer',
  review: 'reviewer',
  judge: 'judge',
  distill: 'distiller',
  archive: 'approver',
};

export function activeRoleForPhase(phase: Phase): string {
  return activeRoleByPhase[phase];
}

/**
 * The next action a phase implies when no task-specific suggestion applies. One table holds the skill, the role that
 * acts, the reason and the priority, so the CLI's fallback action, `nextSkillForPhase` and the dispatcher's own tail
 * ladder cannot disagree about what a phase means.
 */
export const phaseFallback: Record<Phase, { nextSkill: string; role: string; reason: NextActionReason; priority: number }> = {
  intake: { nextSkill: '/kata-design', role: 'designer', reason: 'design_intake_task', priority: 300 },
  plan: { nextSkill: '/kata-build', role: 'implementer', reason: 'choose_execution_mode', priority: 400 },
  implement: { nextSkill: '/kata-build', role: 'implementer', reason: 'continue_implementation', priority: 400 },
  hardVerify: { nextSkill: '/kata-verify', role: 'reviewer', reason: 'verify_fresh_implementation', priority: 700 },
  review: { nextSkill: '/kata-judge', role: 'judge', reason: 'judge_reviewed_change', priority: 600 },
  judge: { nextSkill: '/kata-archive', role: 'distiller', reason: 'archive_judged_change', priority: 500 },
  distill: { nextSkill: '/kata-archive', role: 'distiller', reason: 'archive_judged_change', priority: 500 },
  archive: { nextSkill: '/kata', role: 'dispatcher', reason: 'archived_task', priority: 0 },
};

export function phaseFallbackAction(phase: Phase): { nextSkill: string; role: string; reason: NextActionReason; priority: number } {
  return phaseFallback[phase];
}

export function suggestCandidateAction(phase: string, upstream: UpstreamSummary): SuggestedAction {
  if (phase === 'archive') {
    return phaseFallbackAction('archive');
  }
  if (upstream.mixedRevisionEvidence) {
    return {
      nextSkill: '/kata-build',
      role: 'implementer',
      reason: 'repair_mixed_revision_evidence',
      priority: 2100,
    };
  }
  if (upstream.unresolvedObligations > 0) {
    if (upstream.missingAcceptanceMatrix) {
      return {
        nextSkill: '/kata-design',
        role: 'designer',
        reason: 'migrate_legacy_acceptance_matrix',
        priority: 2050 + upstream.unresolvedObligations,
        acceptanceIds: upstream.unresolvedObligationAcIds,
      };
    }
    return {
      nextSkill: '/kata-build',
      role: 'implementer',
      reason: 'repair_unresolved_obligations',
      priority: 2000 + upstream.unresolvedObligations,
    };
  }
  // When the latest verify failed in review phase, the verify repair reason
  // (rebuild_stale_evidence / rebuild_superseded_revision) must take priority
  // over blocking or major review findings so --seal is attached to the build
  // command and stale evidence is refreshed alongside any finding repairs.
  if (phase === 'review' && upstream.verifyResult === 'FAIL') {
    return {
      nextSkill: '/kata-build',
      role: 'implementer',
      reason: verifyRepairReason(upstream),
      priority: 1020 + upstream.failedVerifyAcceptance,
    };
  }
  if (phase === 'review' && upstream.blockingFindings > 0) {
    return {
      nextSkill: '/kata-build',
      role: 'implementer',
      reason: 'repair_blocking_review_findings',
      priority: 1000 + upstream.blockingFindings,
    };
  }
  if (phase === 'review' && upstream.reviewMode === 'strict' && upstream.majorFindings > 0) {
    return {
      nextSkill: '/kata-build',
      role: 'implementer',
      reason: 'repair_strict_major_findings',
      priority: 980 + upstream.majorFindings,
    };
  }
  if (phase === 'review' && upstream.invalidReviewApproval) {
    return {
      nextSkill: '/kata-review',
      role: 'reviewer',
      reason: 'invalid_review_approval',
      priority: 975,
    };
  }
  if (phase === 'review' && !upstream.reviewReady) {
    return {
      nextSkill: '/kata-review',
      role: 'reviewer',
      reason: 'complete_review_conclusion',
      priority: 970,
    };
  }
  if (phase === 'judge' && upstream.judgeResult === 'FAIL') {
    return {
      nextSkill: '/kata-build',
      role: 'implementer',
      reason: 'repair_failed_judge',
      priority: 900 + upstream.failedAcceptance,
    };
  }
  if (upstream.failingEvidence > 0) {
    return {
      nextSkill: '/kata-build',
      role: 'implementer',
      reason: 'repair_failing_evidence',
      priority: 800 + upstream.failingEvidence,
    };
  }
  // Wiki closure blocks review only when verify has run to a verdict and the implementation itself is ready;
  // otherwise the task still has to be verified or repaired first.
  if (phase === 'hardVerify' && upstream.verifyResult === 'FAIL' && upstream.wikiClosureValid === false && upstream.failedVerifyAcceptance === 0) {
    return {
      nextSkill: '/kata-wiki-enrich',
      role: 'implementer',
      reason: 'resolve_wiki_closure',
      priority: 770,
    };
  }
  if (phase === 'hardVerify' && upstream.verifyResult === 'FAIL') {
    if (uniformScopeReason(upstream.verifyRepairScopes) === 'rebuild_stale_evidence') {
      return {
        nextSkill: '/kata-build',
        role: 'implementer',
        reason: 'rebuild_stale_evidence',
        priority: 760 + upstream.failedVerifyAcceptance,
      };
    }
    // The scope→reason table decides; a failed set with no scope-specific reason falls back to the generic repair.
    return {
      nextSkill: '/kata-build',
      role: 'implementer',
      reason: verifyRepairReason(upstream),
      priority: 750 + upstream.failedVerifyAcceptance,
    };
  }
  if (phase === 'hardVerify' && upstream.verifyResult === 'PASS') {
    return { nextSkill: '/kata-review', role: 'reviewer', reason: 'review_fresh_implementation', priority: 740 };
  }
  if (phase === 'hardVerify') {
    return phaseFallbackAction('hardVerify');
  }
  if (phase === 'review') {
    return phaseFallbackAction('review');
  }
  if (phase === 'judge' || phase === 'distill') {
    return phaseFallbackAction('judge');
  }
  if (phase === 'plan' || phase === 'implement' || phase === 'intake') {
    return phaseFallbackAction(phase);
  }
  if (phase === 'review') {
    return phaseFallbackAction('review');
  }
  return { nextSkill: '/kata', role: 'dispatcher', reason: 'inspect_task', priority: 0 };
}

export function nextSkillForPhase(phase: Phase): string {
  return phaseFallback[phase].nextSkill;
}

export function nextActionForTask(taskId: string, nextSkill: string, role: string, reason: NextActionReason): NextAction {
  const cliVerb = skillToCliVerb(nextSkill);
  const gate = trustBoundaryFor(reason);
  const seal = reason === 'rebuild_stale_evidence' || reason === 'rebuild_superseded_revision' ? ' --seal' : '';
  const wikiClosure = reason === 'resolve_wiki_closure';
  return {
    taskId,
    nextSkill,
    slashCommand: `${nextSkill} ${taskId}${seal}`,
    cliCommand: wikiClosure
      ? `kata-cli wiki closure --task ${taskId} --decision <captured|not_applicable> --reason <reason>`
      : cliVerb ? `kata-cli ${cliVerb} --change ${taskId}${seal}` : `kata-cli status --change ${taskId}`,
    role,
    reason,
    requiresUserConfirmation: gate !== null || wikiClosure,
    modelOrPlatformSwitchAllowed: gate !== null,
    ...(gate ? { trustBoundary: gate } : {}),
    ...(gate ? { pauseInstruction: pauseInstructionForBoundary(gate) } : {}),
    ...(wikiClosure ? { pauseInstruction: '实现验证已通过；请决定本任务的知识闭环是 captured 还是 not_applicable，再重新执行 /kata-verify。' } : {}),
  };
}

function verifyRepairReason(upstream: UpstreamSummary): NextActionReason {
  return uniformScopeReason(upstream.verifyRepairScopes) ?? 'repair_failed_verify';
}

export function statusActionPrompts(suggestion: { nextSkill: string; reason: NextActionReason; role: string; acceptanceIds?: string[] }): string[] {
  if (suggestion.reason === 'choose_execution_mode') {
    return [
      '设计已完成，实施前请确认执行方式：留在当前平台继续，或在任意已识别平台接手自动生成的平台无关交接包。Kata 不会自动切换平台或模型。',
    ];
  }
  if (suggestion.reason === 'continue_implementation') {
    return ['当前处于实施阶段：先写聚焦的失败测试（RED），再最小实现并运行 GREEN；完成后使用 /kata-build <task> --seal 封存证据。'];
  }
  if (suggestion.reason === 'rebuild_stale_evidence') {
    return ['代码在上次证据封存后发生变化；无需重做已完成实现，先执行 /kata-build <task> --seal 重新运行检查并封存新证据。'];
  }
  if (suggestion.reason === 'resolve_wiki_closure') {
    return ['实现验收和证据均已通过；当前仅 Wiki closure 待决。请决定知识是否应 captured 或 not_applicable，记录 closure 后执行 /kata-verify，不要回退到 /kata-build。'];
  }
  if (suggestion.reason === 'repair_blocking_review_findings') {
    return ['检测到 blocking review findings；建议先执行 /kata-build 修复，而不是继续 Judge PASS。'];
  }
  if (suggestion.reason === 'repair_strict_major_findings') {
    return ['检测到 strict 模式的 major review finding；strict 任务必须修复方可进入 Judge，请执行 /kata-build。'];
  }
  if (suggestion.reason === 'complete_review_conclusion') {
    return ['Review 尚未形成绑定当前 revision 的显式结论和审查证据；请完成实际代码审查后，以 /kata-review --approve --review-evidence <summary> 记录结论，或写入 findings。'];
  }
  if (suggestion.reason === 'invalid_review_approval') {
    return ['检测到无效 Review approval：缺少绑定当前 revision 的 reviewEvidence。该产物不能进入 Judge；请重新执行 /kata-review 并记录真实审查结论。'];
  }
  if (suggestion.reason === 'repair_failed_judge') {
    return ['检测到 Judge FAIL；建议先执行 /kata-build 修复 failed acceptance。'];
  }
  if (suggestion.reason === 'repair_failing_evidence') {
    return ['检测到失败 evidence；建议先执行 /kata-build 修复并刷新证据。'];
  }
  if (suggestion.reason === 'repair_failed_verify') {
    return ['检测到 Verify FAIL；建议先执行 /kata-build 修复 failed verification。'];
  }
  if (suggestion.reason === 'repair_unresolved_obligations') {
    return ['检测到未解决的修复义务（repair obligations）；仅创建新 revision 不会关闭，必须用矩阵关联的新鲜通过证据解析。'];
  }
  if (suggestion.reason === 'migrate_legacy_acceptance_matrix') {
    const acceptance = suggestion.acceptanceIds?.length ? `（${suggestion.acceptanceIds.join('、')}）` : '';
    return [`检测到未解决的修复义务${acceptance}，但任务缺少 acceptanceMatrix。0 个当前 findings 不是完成；请先通过 /kata-design 补齐稳定 AC、实现/测试路径和矩阵证据，再修复义务并封存。`];
  }
  if (suggestion.reason === 'repair_mixed_revision_evidence') {
    return ['检测到混合 revision 证据；请执行 /kata-build <task> --seal 重新封存，清除旧 revision 残留证据。'];
  }
  if (suggestion.reason === 'verify_fresh_implementation') {
    return ['实现和项目质检已完成；下一步执行 /kata-verify 校验证据新鲜度、验收覆盖和 blocking findings。'];
  }
  if (suggestion.reason === 'review_fresh_implementation') {
    return ['实现与硬验证已完成；请暂停并让用户选择 Reviewer 使用当前平台/模型、切换平台/模型，或委托给其他 agent。'];
  }
  if (suggestion.reason === 'judge_reviewed_change') {
    return ['Review 已完成；请暂停并让用户选择 Judge 使用当前平台/模型、切换到高阶模型/平台，或委托给其他 agent。'];
  }
  if (suggestion.reason === 'archive_judged_change') {
    return ['Judge 已完成；请暂停并让用户确认是否归档，以及是否先补充 Wiki/发布证据。'];
  }
  if (suggestion.reason === 'archived_task') {
    return ['归档已完成。建议使用 git 提交本轮工作流涉及的所有更改，并推送到远端。'];
  }
  return [`建议执行 ${suggestion.nextSkill}，角色 ${suggestion.role}。`];
}

/**
 * The trust boundary each reason stops at. A `Record` over the whole vocabulary: a new reason has to decide whether it
 * is a gate, instead of silently defaulting to no gate.
 */
const trustBoundaryByReason: Record<NextActionReason, TrustBoundary | null> = {
  choose_execution_mode: 'implementation_gate',
  review_fresh_implementation: 'review_gate',
  judge_reviewed_change: 'judge_gate',
  archive_judged_change: 'archive_gate',
  add_entrypoint_evidence: null,
  adversarial_review_pending: null,
  adversarial_verify_pending: null,
  archived_task: null,
  complete_review_conclusion: null,
  continue_implementation: null,
  design_intake_task: null,
  git_flow_confirmation_required: null,
  inspect_task: null,
  invalid_review_approval: null,
  migrate_legacy_acceptance_matrix: null,
  rebuild_stale_evidence: null,
  rebuild_superseded_revision: null,
  repair_blocking_review_findings: null,
  repair_failed_judge: null,
  repair_failed_verify: null,
  repair_failing_evidence: null,
  repair_mixed_revision_evidence: null,
  repair_strict_major_findings: null,
  repair_unresolved_obligations: null,
  resolve_repair_obligations: null,
  resolve_wiki_closure: null,
  verify_fresh_implementation: null,
};

export function trustBoundaryFor(reason: NextActionReason): TrustBoundary | null {
  return trustBoundaryByReason[reason];
}

function pauseInstructionForBoundary(boundary: TrustBoundary): string {
  if (boundary === 'implementation_gate') {
    return '暂停：设计已完成。Kata 已生成平台无关交接包；可在当前或任意已识别平台接手。Kata 不会自动切换或记录宿主平台模型。';
  }
  if (boundary === 'review_gate') {
    return '暂停：Kata 不能切换宿主平台模型，也不得写入已切换的路由记录。展示推荐平台/模型；请用户先在宿主平台设置中完成切换，再恢复会话并确认实际平台/模型。仅此后才可用 --confirm-host-model 写入审计记录并进入 Review。';
  }
  if (boundary === 'judge_gate') {
    return '暂停：Kata 不能切换宿主平台模型，也不得写入已切换的路由记录。展示 Judge 推荐的平台/模型；请用户先在宿主平台设置中完成切换，再恢复会话并确认实际平台/模型。仅此后才可用 --confirm-host-model 写入审计记录并进入 Judge。';
  }
  return 'Stop after Judge. Ask the user whether to archive now, enrich Wiki first, or collect more release evidence.';
}

function skillToCliVerb(nextSkill: string): string | null {
  const normalized = nextSkill.startsWith('/kata-') ? nextSkill.slice('/kata-'.length) : nextSkill === '/kata' ? 'status' : '';
  if (!normalized) return null;
  if (normalized === 'status') return 'status';
  return normalized;
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function listEvidenceFiles(root: string, taskId: string): Promise<string[]> {
  try {
    const evidenceDirectory = layoutEvidenceDir(root);
    const candidates = (await readdir(evidenceDirectory))
      .filter((file) => file.startsWith(`${taskId}-`) && file.endsWith('.json'));
    const matches = await Promise.all(candidates.map(async (file) => ({
      file,
      evidence: await readJsonFile<{ taskId?: string }>(join(evidenceDirectory, file)),
    })));
    return matches
      .filter(({ evidence }) => evidence?.taskId === taskId)
      .map(({ file }) => file)
      .sort();
  } catch {
    return [];
  }
}
