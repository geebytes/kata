import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Phase } from '../core/state.js';
import {
  boundaryPromptFor,
  promptLanguage,
  statusPromptFor,
  type PromptLanguage,
} from './prompt-catalogue.js';
import type { RepairScope } from '../quality/judge.js';
import { isLegacyTask } from '../quality/acceptance-matrix.js';
import type { AcceptanceMatrix } from '../core/task.js';
import { evaluateWikiClosure } from '../wiki/closure.js';
import { reviewPath, judgePath, verifyPath, taskPath, evidenceDir as layoutEvidenceDir } from '../core/layout.js';
import { readCurrentTaskRevision } from './revision.js';
import { bindsToRevision, type VerdictScope } from './verdict-binding.js';
import { orderedPhases } from '../core/state.js';
import { ledgerVerdict } from '../store/verdict.js';
import { countFindingsBySeverity, mergeBlockingSeverities } from './review-read.js';

/**
 * The ledger's open problems: claims that are neither supported nor waived, with the severity the tier contract gave them.
 *
 * Exported because the ladder and the archive gate must not disagree about which problems are open — the defect this file's
 * history is largely made of — and because a second derivation is exactly what a shared reader prevents.
 */
export async function openLedgerProblems(
    root: string,
    taskId: string,
): Promise<Array<{ id: string; severity: string; statement: string }>> {
    const { readLedger } = await import('../store/ledger.js');
    const { unsupportedClaims } = await import('../store/verdict.js');
    const ledger = await readLedger(root, taskId);
    // The decision, not a second derivation of it: `unsupportedClaims` assembles the input once for every consumer.
    return unsupportedClaims(ledger).map((claim) => ({ id: claim.claimId, severity: claim.severity, statement: claim.statement }));
}

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
  /**
   * **May this change close, and which claims stop it.**
   *
   * Written by this function and, until a test read it, declared by nobody: the object literal carried it and the type did
   * not, so a typed reader could not see it and only a JSON dump showed it. A producer whose output is not declared is one
   * half of the same defect as a declaration nothing reads — the field exists, and no reader can ask for it.
   */
  ledgerClosure?: { mayClose: boolean; unsupportedClaims: string[]; reason: string };
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
  /**
   * The command that completes the step this action starts, when one command is not enough.
   *
   * Measured on a real change: the ladder sent `/kata-review`, whose own `cliCommand` is
   * `kata-cli review --change <id> --approve` — and that command *refused*, because approval requires the task to already
   * be in the `review` phase, which entering review is what produces. The working sequence is two commands, and the ladder
   * named one of them; the reader was told what to type and it did not work. Set only where a step genuinely takes two.
   */
  followUpCommand?: string;
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
  // **The severity the ladder routes on comes from the ledger, not from a findings table.**
  //
  // This is the sixth consumer of one question — "which problems are open and severe enough to block" — and it read
  // `review.json`'s raw findings, then the tracked view, and each repair taught another copy the same lesson. The ledger
  // holds the answer in its own vocabulary: an unsupported claim is a problem, its `severity` is the field the tier
  // contract already requires, and a waiver is the author's decision not to fix it.
  const openProblems: Array<{ id: string; severity: string; statement: string }> = await openLedgerProblems(root, taskId);
  // Counted by name, judged by the ladder: `countFindingsBySeverity` only reports how many carry each name, and
  // **which** of them blocks is `mergeBlockingSeverities`' answer, so this file holds neither a severity literal nor
  // a second copy of the rule.
  const problemCounts = countFindingsBySeverity(openProblems);
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
    reviewFindings: openProblems.length,
    blockingFindings: problemCounts.blocking,
    majorFindings: problemCounts.major,
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
    // **May this round close?** — asked of the ledger rather than of a findings table.
    //
    // This used to compute a closure verdict from `readTrackedFindings`, the falsifier ledger and the class table: three
    // readers of the round-shaped route's records, on the one surface that decides what happens next. With the ledger as
    // the route, the same question has a simpler answer — how many claims are not supported — and the risk classes the
    // tier requires but no claim covers are the class-level half of it, which is what the termination condition is about:
    // "every class an open finding names has a check" became "every class the tier requires has a claim".
    ...(await (async () => {
        const { readLedger } = await import('../store/ledger.js');
        const { unsupportedClaims } = await import('../store/verdict.js');
        const ledgerState = await readLedger(root, taskId);
        const unsupportedIds = new Set(unsupportedClaims(ledgerState).map((decision) => decision.claimId));
        if (ledgerState.claims.length === 0) {
            // No ledger is a state, not an empty verdict: a change on this route may legitimately have none yet, and saying
            // "cannot close" about nothing recorded would be a refusal of work that has not started.
            return {};
        }
        // The kernel's answer, asked once for the whole ledger rather than re-derived per claim.
        const unsupported = ledgerState.claims.filter((claim) => unsupportedIds.has(claim.id));
        if (unsupported.length === 0) return {};
        return {
            ledgerClosure: {
                mayClose: false,
                unsupportedClaims: unsupported.map((claim) => claim.id),
                reason: `${unsupported.length} claim(s) are not supported, so the ledger does not yet decide a pass`,
            },
        };
    })()),
    // The matrix-less fact, asked through the predicate that names it: `isLegacyTask` is `!matrix`, and deriving it here
    // as a second expression is how one fact gets two spellings.
    ...(task && isLegacyTask(task.acceptanceMatrix as AcceptanceMatrix | undefined) ? { missingAcceptanceMatrix: true } : {}),
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
  // **The obligation gate is gone, and the ledger answers the question it asked.** It read "is there a recorded failure
  // that has not been answered yet", which a judge FAIL used to satisfy by writing an obligation —
  // and judge can no longer be reached without a ledger, so nothing creates one for a governed change any more
  // (measured: the only writer of an approved review refuses ledger-less changes, and judge refuses unapproved reviews).
  //
  // The failure is not lost: it lives where the failing criterion lives. That criterion is a claim, its evaluation is a
  // verdict, and an unsupported claim is what `satisfy_ledger_deficits` below routes on. Legacy acceptance matrices keep
  // their own branch, because "the matrix was never declared" is a property of the task rather than of an obligation.
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
  // **A legacy matrix is migrated only when something is asking for it.** The old gate fired when an *obligation* existed
  // on a matrix-less task — the obligation being the record that something needed repairing. Nothing creates obligations
  // for a governed change any more, so the record is the ledger: a matrix-less change whose ledger does not pass is one
  // whose criteria cannot be evidenced structurally, and the repair is to declare the rows. A matrix-less change with no
  // ledger has no recorded failure, and is routed by the verify and judge branches below exactly as it was before.
  if (upstream.missingAcceptanceMatrix && upstream.ledger && upstream.ledger.state === 'decided' && upstream.ledger.verdict !== 'pass') {
    return {
      nextSkill: '/kata-design',
      role: 'designer',
      reason: 'migrate_legacy_acceptance_matrix',
      priority: 1985,
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
  // **One ladder, read twice.** The severities that block come from `mergeBlockingSeverities`, ordered hardest first,
  // so position 0 is the severity every mode refuses and position 1 is the one only the tiers above std do. This used
  // to be two blocks of prose plus a `=== 'strict'` literal, which is why `security` — a tier the kernel gives two
  // reviewers, always-on quorum and a sandboxed assurance floor — blocked on *less* than the tier below it.
  const blockingSeverities = mergeBlockingSeverities(upstream.reviewMode);
  const hardestSeverity = blockingSeverities[0];
  if (phase === 'review' && hardestSeverity !== undefined && upstream.blockingFindings > 0) {
    return {
      nextSkill: '/kata-build',
      role: 'implementer',
      reason: 'repair_blocking_review_findings',
      priority: 1000 + upstream.blockingFindings,
    };
  }
  if (phase === 'review' && blockingSeverities.length > 1 && upstream.majorFindings > 0) {
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
  // **The round-closure branch is gone with the class table.** It fired on `upstream.roundClosure`, which nothing has
  // produced since the class table was deleted with the old route — so the branch was unreachable, and `chainQuorum`-style
  // dead code on the surface that decides what happens next is worse than absent code: a reader cannot tell a bound that
  // was never reached from a bound that no longer exists. The question it asked ("is every class covered") is now the
  // tier's `requiredRiskClasses` contract, enforced by `decide` and reported as `uncovered_risk_class`.
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
    // **A two-step step says so.** Entering review and approving are different commands, and the one the ladder named was
    // the second: it refuses until the first has run, so an operator following the ladder hits a refusal whose remedy is a
    // command the ladder did not mention.
    ...(reason === 'review_fresh_implementation'
        ? {
            followUpCommand: `kata-cli review --change ${taskId} --approve --review-evidence "<what the ledger decided and why it suffices>"`,
            // **Composed with the boundary prompt, not instead of it.** The first version of this replaced
            // `pauseInstruction` and dropped the trust-boundary text that carries the mandatory "kata does not route host
            // models" notice and the `--confirm-host-model` step — trading two required facts for one convenience, which is
            // the shape this repository removes most often. The boundary text goes first because the pause happens first.
            pauseInstruction: `${gate ? boundaryPromptFor(gate, promptLanguage()) : ''} 进入 review 后要跑两条命令：\`kata-cli review --change ${taskId}\` 先把相位推进 review，\`kata-cli review --change ${taskId} --approve\` 在相位推进前会被拒绝。`,
        }
        : {}),
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
