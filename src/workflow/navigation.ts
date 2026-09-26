import { readTrackedFindings } from '../quality/finding-disposition.js';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Phase } from '../core/state.js';
import {
  boundaryPromptFor,
  promptLanguage,
  statusPromptFor,
  type PromptLanguage,
} from './prompt-catalogue.js';
import { evaluateWikiClosure } from '../wiki/closure.js';
import { readObligations } from '../quality/repair-obligations.js';
import type { RepairScope } from '../quality/judge.js';
import { reviewPath, judgePath, verifyPath, taskPath, evidenceDir as layoutEvidenceDir } from '../core/layout.js';
import { readCurrentTaskRevision } from './revision.js';
import { bindsToRevision, type VerdictScope } from './verdict-binding.js';
import { orderedPhases } from '../core/state.js';
import { ledgerVerdict } from '../store/verdict.js';

export type UpstreamSummary = {
  currentRevisionId?: string;
  reviewFindings: number;
  blockingFindings: number;
  majorFindings: number;
  reviewMode?: string;
  /** Present when the round may NOT close, naming the classes that no check covers (fix item 4). */
  roundClosure?: { mayClose: boolean; reason: string; open?: Array<{ classId: string; covered: boolean }>; classless?: Array<{ id: string }> };
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
  /**
   * What the evidence ledger decides, when the change has one.
   *
   * `absent` is a fact the ladder acts on rather than a silent fallback: a change with no ledger is still decided by the
   * round-shaped record, and saying so is what keeps that route visible while it is retired. `unreadable` is kept apart
   * from `absent`, because something written and unreadable decides nothing while a ledger nobody wrote never claimed to.
   */
  ledger?: {
    state: 'absent' | 'unreadable' | 'decided';
    verdict: 'pass' | 'fail' | 'insufficient' | null;
    claims: number;
    /** The reason codes, or the detail of why nothing was decided. */
    reason: string;
    /** The kernel's own list of what is missing, which is what a repair is supposed to satisfy. */
    deficits: string[];
  };
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
  'cover_uncovered_classes',
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
  'satisfy_ledger_deficits',
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
  // Declaring the missing row is Build's work, and the repair entry is Build's own default.
  no_acceptance_matrix_row: null,
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
  // **The sixth consumer of one question, and the one that decides the ladder's next action** (`kgsr13-f1`). It read `review.json`
  // raw — findings carry no disposition there — so `blockingFindings`/`majorFindings` counted findings that had already been fixed,
  // accepted below the bar or routed, and a routed finding gated the ladder for ever. Every other consumer was repaired for this
  // same shape within one day (`cg-f1`, `kgsr7-f3`, `rba-r3-f3`, `wcc7-f3`, the review admission, `findings accept`); this one was
  // missed because it reads the file directly rather than through the tracked view.
  // **Counted by its own disposition, not by whether an obligation answered it** (`kgsr13-f1`, measured on the routing fixtures):
  // an answered obligation says "this repair has been shown to work", which is not the same as "this defect is gone", and a ladder
  // that cannot see a severity after its obligation is answered cannot route it. A finding is out of the count when a *decision*
  // was recorded on it — `fixed`, `accepted`, `deferred` or `routed` — and the tracked view is what carries those.
  const trackedFindings = await readTrackedFindings(root, taskId).catch(() => []);
  const findings = trackedFindings
    .filter((finding) => (finding.disposition ?? 'open') === 'open')
    // **Still bound to the current evidence revision**, which is what the record read did before: a finding raised against a
    // revision that is no longer current is stale, exactly as a stale review record is, and `readTrackedFindings` carries no such
    // filter because its other consumers ask about a task's findings rather than about one revision's.
    .filter((finding) => !currentRevisionId || !finding.revisionId || finding.revisionId === currentRevisionId)
    .map((finding) => ({ severity: finding.severity }));
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
  // **The new path's verdict, asked in one place.** `ledgerVerdict` is also what the CLI's `decide` verb calls, so the
  // ladder and the operator cannot see two different answers to the same question — the defect this repository keeps
  // finding, and the reason this is a call rather than a second assembly.
  const ledgerDecision = await ledgerVerdict({ root, changeId: taskId });
  const ledger = ledgerDecision.kind === 'decided'
    ? {
        state: 'decided' as const,
        verdict: ledgerDecision.decision.verdict,
        claims: ledgerDecision.claims,
        reason: ledgerDecision.decision.reasons.map((entry) => entry.code).join(', ') || 'no reason given',
        deficits: ledgerDecision.decision.deficits.map((deficit) => `${deficit.claimId}: ${deficit.need}`),
      }
    : {
        state: ledgerDecision.kind,
        verdict: null,
        claims: 0,
        reason: ledgerDecision.detail,
        deficits: [] as string[],
      };
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
    ledger,
    evidenceFiles,
    failingEvidence: evidence.filter((item) => item && typeof item.exitCode === 'number' && item.exitCode !== 0).length,
    unresolvedObligations: unresolvedObligations.length,
    // **May this round close?** Reported where the ladder reads, because the loop's missing termination condition is what made seven
    // rounds: `closure-gate` ran five and this change seven, and every round's findings were about the previous round's repairs —
    // a repair is new code and the round exists to find defects in new code. The condition that can fail is not "no findings" (each
    // repair produces material) but "every class an open terminal finding names is covered by a check that reddens when the class
    // returns". `roundClosure` carries that verdict and names the uncovered classes, so the next action is to cover a class rather
    // than to repair one more instance.
    ...(await (async () => {
        // **One derivation, five call sites.** Computed here rather than passed in, because five callers passing their own answer is how
        // this line produced six instances of "one concept derived in several places". The findings and the coverage table are read
        // from the sources the disposition commands already write through.
        const { coveredClasses } = await import('../quality/class-coverage.js');
        const { roundMayClose } = await import('../quality/finding-lifecycle.js');
        // **Not swallowed** (`rba10-f1`): `readTrackedFindings` was changed to throw on an invalid record rather than read it as
        // an absent one, and then both production callers wrapped the call in `.catch(() => [])` — so a schema-invalid record still
        // arrived as an empty list and `roundMayClose([])` still returned `mayClose: true`. A swallow at the call site defeats a
        // throw at the callee, and the verdict is what the caller computes.
        const tracked = await (await import('../quality/finding-disposition.js')).readTrackedFindings(root, taskId);
        // **A disposition in either store closes the finding**, which is the same rule `repairBriefing` applies: a finding carries
        // an absence in the falsifier ledger while one store still reads `open`, so a closure verdict computed from one store says
        // "may close" about work a briefing would still hand out. One rule, asked in both places.
        const { readFalsifierReddenings, readFalsifierAbsences } = await import('../quality/falsifier-reddenings.js');
        const disposed = new Set([
            ...(await readFalsifierReddenings(root, taskId).catch(() => [])).map((entry) => entry.findingId),
            ...(await readFalsifierAbsences(root, taskId).catch(() => [])).map((entry) => entry.findingId),
        ]);
        const open = tracked
            .filter((finding) => finding.disposition === 'open' && !disposed.has(finding.id))
            .map((finding) => ({ id: finding.id, severity: finding.severity, ...(finding.classInstances ? { classInstances: finding.classInstances } : {}) }));
        // **Derived from the table, not written here** (`rba8-f2`): the literal `covered: true` made the predicate's uncovered
        // branch unreachable, so the verdict could not fail.
        const verdict = roundMayClose(open, coveredClasses());
        // **The loop's price, beside its termination condition.** Seven recorded rounds cost 351,864 / 658,523 / 347,000 / 400,000 /
        // 875,572 / 510,836 / 1,073,271 tokens and produced 7 / 0 / 5 / 5 / 0 / 7 findings — the two most expensive produced zero
        // because they never wrote a record, and the cheapest produced seven. Cost and yield are not correlated, which is why this
        // is a fact to report rather than a number to drive down; and it is here because this change has three criteria and none
        // mentions cost, so "the cost has not fallen" was not a fact anything could fail on.
        const { reportRoundCost } = await import('../quality/round-cost.js');
        const cost = await reportRoundCost(root, taskId, 'review').catch(() => null);
        const costField = cost && cost.totalTokens > 0
            ? { roundCost: { totalTokens: cost.totalTokens, rounds: cost.rounds.length, ...(cost.latest ? { latest: cost.latest } : {}), ...(cost.range ? { range: cost.range } : {}) } }
            : {};
        // The closure verdict is reported only when it has something to say: a round that may close needs no explanation, and a field
        // that is always present reads as a fact worth watching when it is not.
        return verdict.mayClose ? costField : { roundClosure: verdict, ...costField };
    })()),
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
  current: { revisionId: string; manifestHash?: string | null; codeManifestHash?: string | null },
  options: { scope?: VerdictScope } = {},
): T | null {
  return artifact && bindsToRevision(artifact, { revisionId: current.revisionId, manifestHash: current.manifestHash ?? null, codeManifestHash: current.codeManifestHash ?? null }, options)
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
 * The role a task in this phase is activated as — the same table the hook guard accepts.
 *
 * It lived in the CLI while the table it reads lived here, which is the arrangement L2-01 removed everywhere else: a
 * reader in one module and its data in another, with nothing but convention keeping them in step.
 */
export function roleForPhase(phase: Phase | string): string {
    return (orderedPhases as readonly string[]).includes(phase) ? activeRoleForPhase(phase as Phase) : 'approver';
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
  // **The ledger's own decision is the authority when the change has one.** It accounts for evidence strength, stale
  // verdicts, open counterexamples and the discovery floor in one place, where the branches below count findings — and
  // counting findings is the part this replaces. It sits below the two state gates above it (mixed-revision evidence,
  // unresolved obligations), because those make every piece of evidence meaningless rather than merely insufficient.
  if (upstream.ledger && upstream.ledger.state === 'decided' && upstream.ledger.verdict !== 'pass') {
    return {
      nextSkill: '/kata-build',
      role: 'implementer',
      reason: 'satisfy_ledger_deficits',
      priority: 1990 + upstream.ledger.deficits.length,
    };
  }
  if (upstream.ledger && upstream.ledger.state === 'unreadable') {
    // A ledger that exists and cannot be read decides nothing, and that is not the same fact as one that was never
    // written — so it refuses here rather than falling through to the round-shaped branches as if nothing were wrong.
    return {
      nextSkill: '/kata-build',
      role: 'implementer',
      reason: 'satisfy_ledger_deficits',
      priority: 1995,
    };
  }
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
  // Strict mode, deliberately: the severity gate is "blocking, and major in strict" (design
  // `2026-09-18-what-an-adversarial-pass-costs.md`). In std a major finding is reported and does not hold the task back.
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
  // **The round's conclusion criterion, in the ladder's vocabulary** (fix item 4). The loop's measured shape is that findings per
  // round *rise* rather than fall — `closure-gate` [7, 5, 5, 2, 5, 9, 10, 12, 14, 14] — because every repair is new code and the round
  // exists to find defects in new code. So "no findings" is unreachable and was never the right bound; the bound that can fail is
  // "every class an open finding names is covered by a check that reddens when the class returns", which `roundClosure` computes.
  //
  // Until this branch existed that verdict was only a field on `status`: the operator read it, and the ladder above still said "repair"
  // for an open instance of an already-covered class. Naming it as the next action is the difference between a bound that is reported
  // and a bound that is used.
  if (phase === 'review' && upstream.roundClosure) {
    return {
      nextSkill: '/kata-review',
      role: 'reviewer',
      reason: 'cover_uncovered_classes',
      priority: 972,
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
    ...(gate ? { pauseInstruction: boundaryPromptFor(gate, promptLanguage()) } : {}),
    ...(wikiClosure ? { pauseInstruction: '实现验证已通过；请决定本任务的知识闭环是 captured 还是 not_applicable，再重新执行 /kata-verify。' } : {}),
  };
}

function verifyRepairReason(upstream: UpstreamSummary): NextActionReason {
  return uniformScopeReason(upstream.verifyRepairScopes) ?? 'repair_failed_verify';
}

export function statusActionPrompts(
  suggestion: { nextSkill: string; reason: NextActionReason; role: string; acceptanceIds?: string[] },
  language: PromptLanguage = promptLanguage(),
): string[] {
  // The prompts live in `prompt-catalogue.ts`, one entry per reason with both languages (L2-08): this function used to
  // hold fifteen Chinese strings while the boundary instructions held three Chinese ones and one English, and the
  // product's configured language never reached either.
  return [statusPromptFor(suggestion.reason, language, suggestion)];
}


/**
 * The trust boundary each reason stops at. A `Record` over the whole vocabulary: a new reason has to decide whether it
 * is a gate, instead of silently defaulting to no gate.
 */
const trustBoundaryByReason: Record<NextActionReason, TrustBoundary | null> = {
  choose_execution_mode: 'implementation_gate',
  cover_uncovered_classes: null,
  satisfy_ledger_deficits: null,
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
