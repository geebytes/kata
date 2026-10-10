  // **The terminal state is evaluated first — of everything that returns a repair route.**
  //
  // **Measured: it was not, twice.** It first sat below the two ledger branches while its own comment claimed the
  // opposite order, so a change whose loop had escalated *and* whose ledger was unreadable or failing was dispatched to
  // `/kata-build` (a looping repair is exactly the state in which the ledger is likely to be broken too). It was then
  // moved above those two and left below `mixedRevisionEvidence` on the argument that mixed evidence "is a fact about the
  // evidence, not a route out of a stuck loop" — and that argument was wrong for the same reason: an escalated loop
  // whose evidence names two revisions was still dispatched to `/kata-build`, which is the one thing AC-4 forbids.
  //
  // So the rule is stated as what it is: **every branch that returns a repair route is below this one.** What remains
  // above it is `phase === 'archive'`, which is not a repair route but the end of the workflow.
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
import { isPassing } from '../quality/evidence.js';
import type { AcceptanceMatrix } from '../core/task.js';
import { evaluateWikiClosure } from '../wiki/closure.js';
import { reviewPath, judgePath, verifyPath, taskPath, evidenceDir as layoutEvidenceDir } from '../core/layout.js';
import { readReviewDecisionSnapshot } from './revision.js';
import { bindsToRevision, type VerdictScope } from './verdict-binding.js';
import { orderedPhases } from '../core/state.js';
import { ledgerVerdict } from '../store/verdict.js';
import { readBlockingProblems } from './review-read.js';
import { countFindingsBySeverity, mergeBlockingSeverities, type MergeBlockingProblem } from '../quality/review-ladder.js';
import { assessReviewLoop, classRecurrence, readReviewRoundsState, recurrenceAcrossRevisions, type ClassRecurrence, type ReviewLoopAssessment, type ReviewRecurrence } from '../quality/repair.js';
import { isJsonRecord, readDirectoryState, readRecordState, usableOrNull } from '../core/record-read.js';


type AcceptanceItem = { result?: string; repairScope?: string };
type AcceptanceRecord = { acceptance?: AcceptanceItem[] };

/**
 * The status reader consumes `acceptance` immediately below. A JSON object is not necessarily a usable judge/verify
 * record: its nested collection needs the same shape boundary as the outer record, or a corrupt persisted value reaches
 * `.filter()` and turns a reportable refusal into a TypeError.
 */
function isAcceptanceRecord(value: Record<string, unknown>): value is AcceptanceRecord {
  const acceptance = value.acceptance;
  if (acceptance === undefined) return true;
  if (!Array.isArray(acceptance)) return false;
  return acceptance.every((item) => isJsonRecord(item)
    // **Every nested field this summary reads is typed here.** `id` was unchecked, so an entry keyed by a number reached the
    // acceptance reporting as an unnamed criterion — a value no reader could match to a criterion, arriving as a criterion
    // that failed to match rather than as a record somebody has to repair.
    && (item.id === undefined || typeof item.id === 'string')
    && (item.result === undefined || typeof item.result === 'string')
    && (item.repairScope === undefined || typeof item.repairScope === 'string'));
}

/**
 * The shape of a review record, at the nested values the summary and the approval check consume.
 *
 * The record is a JSON object with a status and a body of findings; a damaged one is **unreadable**, which routes and reports
 * under its own name, rather than *absent*, which reads as "nobody reviewed this yet". The two must not be interchangeable:
 * the first asks an operator to repair a file, the second says the work has not been done.
 */
function isReviewRecord(value: Record<string, unknown>): value is { revisionId?: string; manifestHash?: string; status?: string; reviewEvidence?: string } {
  const typed = (field: unknown): boolean => field === undefined || typeof field === 'string';
  if (!typed(value.revisionId) || !typed(value.manifestHash) || !typed(value.status) || !typed(value.reviewEvidence)) return false;
  if (!typed(value.reviewRoute) || !typed(value.subjectRevision) || !typed(value.reviewedRevisionId)) return false;
  // `findings` is the collection the round exists for. Present and not an array of objects is a record nobody can use, and
  // `declaredCoverage` is the declaration beside it — both are read by consumers that assume a list.
  if (value.findings !== undefined && (!Array.isArray(value.findings) || !value.findings.every((item) => isJsonRecord(item)))) return false;
  if (value.declaredCoverage !== undefined
    && (!Array.isArray(value.declaredCoverage) || !value.declaredCoverage.every((item) => typeof item === 'string'))) return false;
  return true;
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
  /** Judge record answered a different declared question and is not current. */
  judgeStaleSubject?: string;
  verifyResult?: string;
  failedAcceptance: number;
  failedVerifyAcceptance: number;
  repairScopes: RepairScope[];
  verifyRepairScopes: RepairScope[];
  wikiClosureValid?: boolean;
  wikiClosureReason?: string;
  evidenceFiles: string[];
  failingEvidence: number;
  /** Present on all runtime summaries; optional for legacy test/status payload compatibility. */
  reviewLoop?: ReviewLoopAssessment;
  /**
   * A record this summary could not read, named rather than folded into the field it would have filled.
   *
   * The summary is what routing and status read, so a damaged record that arrived as "no ledger" or "no summary" would be a
   * fact about the reader reported as a fact about the change. Present only when there is something to report.
   *
   * Set by the candidate listing for a task whose *state* record could not be read (the per-source fields below carry the
   * summary's own reads, each under its own name).
   */
  unreadable?: string;
  /**
   * Findings recorded against more than one revision — a problem that came back after a repair.
   *
   * A report, not a verdict about the current revision: it spans revisions by construction, which is exactly what the
   * current-revision count cannot do. `null` when the round history could not be read (that state routes on its own).
   */
  reviewLoopRecurrence?: ReviewRecurrence[] | null;
  /** The same recurrence counted by defect class, with the repair-origin count — a report, not a gate. */
  reviewLoopClassRecurrence?: ClassRecurrence[] | null;
  /** @deprecated Projection of `reviewLoop.stalled_current_rounds`; routing never reads it. */
  reviewEscalation?: { rounds: number; noProgressRounds: number; blockingIds: readonly string[]; unmeasurable?: boolean };
  /** @deprecated Projection of `reviewLoop.unreadable_round_history`; routing never reads it. */
  /**
   * Whether the review-round history could not be read.
   *
   * Derived from the round read itself, not from `reviewLoop`: that assessment answers one `kind`, so with the pointer and
   * the round log both unreadable it could only ever report one of them. Routing still reads the assessment, not this.
   */
  reviewHistoryUnreadable?: boolean;
  /** Why the recorded review could not be read, when it could not be. */
  reviewRecordUnreadable?: string;
  /**
   * Why the evidence ledger could not be read, when it could not be.
   *
   * Its own field rather than sharing the review record's: the two arrive through one reader, and a status that published
   * both under `reviewRecordUnreadable` said "the review record is unreadable" about a corrupt `claims.json`. Whoever
   * reads this has to be able to tell which artefact to repair.
   */
  ledgerUnreadable?: string;
  /**
   * Why one of the summary's own records could not be read, when it could not be.
   *
   * These were read through a helper that answered `null` for every failure, so a damaged `judge.json` was reported as a
   * change that had not been judged — the same shape as the ledger's, one reader further out. Each names its artefact.
   */
  judgeUnreadable?: string;
  verifyUnreadable?: string;
  taskUnreadable?: string;
  evidenceUnreadable?: string;
  /**
   * Why the sealed pointer could not be read, when it could not be.
   *
   * Its own read, for the same reason as the round history's: routing reads `reviewLoop`, this field is the fact.
   */
  currentRevisionUnreadable?: string;
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
  'escalate_review_without_progress',
  'review_loop_recurring',
  // The same recurrence counted by defect class: a mechanizable class that came back inside a repair, which is the shape
  // mechanization is supposed to end. Reported and routed, never a gate change.
  'review_class_recurring',
  'review_loop_unmeasurable',
  'unreadable_review_record',
  'repair_unreadable_current_revision',
  'repair_unreadable_round_history',
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
  const evidenceReads = await Promise.all(evidenceFiles.map((file) => readRecordState<{ exitCode?: number; expectExitCode?: number; passed?: boolean; revisionId?: string }>(join(layoutEvidenceDir(root), file))));
  // The payload for the computations below, and the refusals kept aside: an evidence file that cannot be read is still an
  // evidence file of this task, and dropping it from the set made `failingEvidence` count a directory the operator could
  // not reconcile with the one on disk.
  const evidence = evidenceReads.map((read) => usableOrNull(read));
  const evidenceUnreadable = evidenceReads
    .map((read, index) => (read.kind === 'unreadable' ? `${evidenceFiles[index]}: ${read.detail}` : null))
    .filter((detail): detail is string => detail !== null);
  const revisionIds = [...new Set(evidence.map((item) => item?.revisionId).filter((id): id is string => Boolean(id)))];
  const mixedRevision = revisionIds.length > 1;
  const currentRevisionId = revisionIds.length === 1 ? revisionIds[0] : undefined;
  // The sealed content, so a verdict that named the previous id but reviewed the same bytes still counts.
  //
  // **Read through the three-state reader, because this is the surface that used to crash on drift.** A corrupted
  // `current-revision.json` threw here while the sibling reader (`readReviewRecord`, on the same file set) refused with a
  // reason — one fact, two answers. `absent` is a normal state for a change nobody has sealed yet; `unreadable` is a
  // refusal, reported below in the same shape the review record's unreadable state is.
  const snapshot = await readReviewDecisionSnapshot(root, taskId);
  const sealedRead = snapshot.revisionRead;
  const sealed = sealedRead.kind === 'current' ? sealedRead.revision : null;
  const binding = { revisionId: currentRevisionId ?? '', manifestHash: sealed?.manifestHash ?? null };
  // **The record's payload, and its own read.** This is the `status`/`reviewEvidence` shape only — the findings are read
  // by `readBlockingProblems`, through the reader that binds them to the current revision, and declaring them here too
  // would be a second reader waiting to disagree. The read is taken once and reused for both branches below.
  // **The review record is shape-checked like every other record here, at the nested values this summary reads.** It had no
  // shape at all, so a record that parsed but did not hold what the summary consumes (`"findings": "none"`, `"status": 42`)
  // arrived as *usable* and was folded into the summary as a review that recorded nothing — a fact about the reader reported
  // as a fact about the change, which is the one thing this reader exists to prevent.
  const reviewRecordRead = await readRecordState<{ revisionId?: string; manifestHash?: string; status?: string; reviewEvidence?: string }>(reviewPath(root, taskId), isReviewRecord);
  const review = mixedRevision
    ? null
    : currentRevisionId
      ? onlyCurrentRevision(usableOrNull(reviewRecordRead), binding)
      : usableOrNull(reviewRecordRead);
  // **The severity the ladder routes on comes from the ledger, not from a findings table.**
  //
  // This is the sixth consumer of one question — "which problems are open and severe enough to block" — and it read
  // `review.json`'s raw findings, then the tracked view, and each repair taught another copy the same lesson. The ledger
  // holds the answer in its own vocabulary: an unsupported claim is a problem, its `severity` is the field the tier
  // contract already requires, and a waiver is the author's decision not to fix it.
  // **The blocking question, asked once, of the reader every other consumer asks.** The status this file returns is what
  // the router and the surfaces read, and it used to assemble its own inputs — one of three call sites that did, which is
  // how the approval and the archive gate came to answer the same question differently.
  // **Handed the read taken above.** Asking for the pointer again is how a failing second read came to be reported as an
  // unreadable *review record* — a different reason, a different route, and one that bypasses the branch written for this
  // very state.
  // **The ledger is read once for this summary.** `ledgerVerdict` and `openLedgerProblems` each opened ten ledger files,
  // so one decision read them twice — the same defect the pointer's read was fixed for, left on the ledger. The read is
  // taken here (dynamically, because `store/ledger` reaches `core/state` which reaches the distill gate that calls this
  // module) and handed to both.
  const { answersCurrentQuestion, declaredSubjectRevision, questionBinding, readLedger } = await import('../store/ledger.js');
  const ledgerInHand = await readLedger(root, taskId);
  const blockingRead = await readBlockingProblems(root, taskId, sealedRead, ledgerInHand);
  // **The new path's verdict, asked in one place.** `ledgerVerdict` is also what the CLI's `decide` verb calls, so the
  // ladder and the operator cannot see two different answers to the same question — the defect this repository keeps
  // finding, and the reason this is a call rather than a second assembly.
  const ledgerDecision = await ledgerVerdict({ root, changeId: taskId, ledger: ledgerInHand });
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
  const reviewRounds = await readReviewRoundsState(root, taskId);
  const reviewLoop = assessReviewLoop({
    currentRevision: sealedRead.kind === 'current'
      ? { kind: 'current', identity: { revisionId: sealedRead.revision.id, manifestHash: sealedRead.revision.manifestHash } }
      : sealedRead,
    reviewRounds,
  });
  const invalidReviewApproval = review?.status === 'approved' && !review.reviewEvidence?.trim();
  const judgeRead = await readRecordState<AcceptanceRecord & { revisionId?: string; manifestHash?: string; result?: string; subjectRevision?: string }>(judgePath(root, taskId), isAcceptanceRecord);
  const rawJudge = mixedRevision
    ? null
    : currentRevisionId
      ? onlyCurrentRevision(usableOrNull(judgeRead), binding)
      : usableOrNull(judgeRead);
  const currentSubjectRevision = declaredSubjectRevision(ledgerInHand);
  const judgeStaleSubject = rawJudge && !answersCurrentQuestion(questionBinding(rawJudge.subjectRevision, currentSubjectRevision))
    ? rawJudge.subjectRevision
    : undefined;
  const judge = judgeStaleSubject ? null : rawJudge;
  const failedAcceptance = judge?.acceptance?.filter((item) => item.result === 'FAIL') ?? [];
  const verifyRead = await readRecordState<AcceptanceRecord & { revisionId?: string; manifestHash?: string; result?: string }>(verifyPath(root, taskId), isAcceptanceRecord);
  const verify = mixedRevision
    ? null
    : currentRevisionId
      ? onlyCurrentRevision(usableOrNull(verifyRead), binding)
      : usableOrNull(verifyRead);
  const failedVerifyAcceptance = verify?.acceptance?.filter((item) => item.result === 'FAIL') ?? [];
  const wikiClosure = await evaluateWikiClosure(root, taskId);
  const taskRead = await readRecordState<{ acceptanceMatrix?: unknown; workflowProfile?: { reviewMode?: string } }>(taskPath(root, taskId));
  const task = usableOrNull(taskRead);
  const reviewMode = task?.workflowProfile?.reviewMode;
  // **Unreadable is an open blocking state, not an empty projection.** A status that published `ledger: unreadable`
  // alongside `reviewFindings: 0` made the same unreadable ledger say both "nobody can decide" and "nothing blocks".
  //
  // **And every unreadable artefact gets its own problem, under its own name.** The blocking reader refuses on the first
  // artefact it cannot read, so deriving the published problems from its single `source` left the others unnamed: a pointer
  // that could not be read borrowed the review record's field, and with both the record and the ledger corrupt only one of
  // them got an id — while the count said one refusal where there were two. The facts are independent and all of them are
  // read here, so each one names itself and none can stand in for another.
  const unreadableProblems: MergeBlockingProblem[] = [];
  if (sealedRead.kind === 'unreadable') {
    unreadableProblems.push({ source: 'claim', id: 'current_revision_unreadable', severity: 'blocking', message: sealedRead.detail });
  }
  if (reviewRounds.kind === 'unreadable') {
    // Published from the round read rather than from `assessReviewLoop`, which answers one `kind` and so reported only the
    // pointer when both were unreadable. Routing still reads the assessment; this is the fact, and it gets its own problem
    // for the same reason the others do.
    unreadableProblems.push({ source: 'claim', id: 'round_history_unreadable', severity: 'blocking', message: reviewRounds.detail });
  }
  if (!blockingRead.ok && blockingRead.source === 'review-record') {
    unreadableProblems.push({ source: 'claim', id: 'review_record_unreadable', severity: 'blocking', message: blockingRead.why });
  }
  if (ledger.state === 'unreadable') {
    unreadableProblems.push({ source: 'claim', id: 'ledger_unreadable', severity: 'blocking', message: ledger.reason });
  }
  // **The summary's own reads are facts of the same kind, and they were the ones with no reader that could tell.** Each was
  // read through a helper that answered `null` for every failure, so a corrupt record was indistinguishable from a missing
  // one and nothing was published at all: a damaged `judge.json` said only that this change had not been judged.
  // **One file, one name.** The review record is read here and again by the blocking reader that binds its findings to a
  // revision; a second id for the same damaged file would be one fact with two answers, which is what this change keeps
  // removing. So this read contributes to the established name only when the blocking reader did not already report it —
  // which is the case when the record parses but does not hold what either reader consumes.
  const reviewRecordReason = reviewRecordRead.kind === 'unreadable' ? reviewRecordRead.detail : null;
  if (reviewRecordReason !== null && blockingRead.ok) {
    unreadableProblems.push({ source: 'claim', id: 'review_record_unreadable', severity: 'blocking', message: reviewRecordReason });
  }
  if (judgeRead.kind === 'unreadable') {
    unreadableProblems.push({ source: 'claim', id: 'judge_unreadable', severity: 'blocking', message: judgeRead.detail });
  }
  if (verifyRead.kind === 'unreadable') {
    unreadableProblems.push({ source: 'claim', id: 'verify_unreadable', severity: 'blocking', message: verifyRead.detail });
  }
  if (taskRead.kind === 'unreadable') {
    unreadableProblems.push({ source: 'claim', id: 'task_unreadable', severity: 'blocking', message: taskRead.detail });
  }
  for (const detail of evidenceUnreadable) {
    unreadableProblems.push({ source: 'claim', id: 'evidence_unreadable', severity: 'blocking', message: detail });
  }
  // **The union, not a choice.** The blocking reader refuses on the first artefact it cannot read, so asking *whether* it
  // succeeded decided whether any of the facts above were published at all — and a refusal derived independently of it went
  // unpublished whenever it had nothing to refuse on. Measured: a corrupt pointer with no `review.json` published
  // `currentRevisionUnreadable` and `reviewFindings: 0`.
  const openProblems: ReadonlyArray<MergeBlockingProblem> = [
    ...(blockingRead.ok ? blockingRead.openProblems : []),
    ...unreadableProblems,
  ];
  const problemCounts = countFindingsBySeverity(openProblems);

  return {
    ...(currentRevisionId ? { currentRevisionId } : {}),
    reviewFindings: openProblems.length,
    blockingFindings: problemCounts.blocking,
    majorFindings: problemCounts.major,
    ...(reviewMode ? { reviewMode } : {}),
    // A record that cannot be read is not a record that says nothing: the router has to be able to refuse on it. Each
    // source keeps its own field, so the refusal that reaches an operator names the artefact it is about.
    ...(!blockingRead.ok && blockingRead.source === 'review-record' ? { reviewRecordUnreadable: blockingRead.why } : {}),
    // **And the ledger's refusal comes from the ledger's own read, not from whichever reader reached it first.** The
    // blocking reader short-circuits on the review record, so with *both* artefacts corrupt it returned only the record's
    // reason — and the ledger's field went missing while `ledger.state` sat right here in the same summary saying
    // `unreadable`. Reading it from the state makes the two sources independent, which is what naming them was for.
    ...(ledger.state === 'unreadable' ? { ledgerUnreadable: ledger.reason } : {}),
    // **And the summary's own reads name themselves too.** A record that cannot be read is not a record that says nothing,
    // and until now the only thing this status could say about a damaged `judge.json` was that no judgement was recorded.
    // Published under the file's one name, and only when the blocking reader did not already name it: `blockingRead`
    // short-circuits on the record, so with both sources damaged the record's reason is the one that would have gone missing
    // (the ledger's is read from the state, which is what makes the two sources independent).
    ...(reviewRecordReason !== null && !(!blockingRead.ok && blockingRead.source === 'review-record')
      ? { reviewRecordUnreadable: reviewRecordReason }
      : {}),
    ...(judgeRead.kind === 'unreadable' ? { judgeUnreadable: judgeRead.detail } : {}),
    ...(verifyRead.kind === 'unreadable' ? { verifyUnreadable: verifyRead.detail } : {}),
    ...(taskRead.kind === 'unreadable' ? { taskUnreadable: taskRead.detail } : {}),
    ...(evidenceUnreadable.length > 0 ? { evidenceUnreadable: evidenceUnreadable.join('; ') } : {}),
    reviewReady: review?.status === 'approved' && Boolean(review.reviewEvidence?.trim()),
    ...(invalidReviewApproval ? { invalidReviewApproval: true } : {}),
    ...(judge?.result ? { judgeResult: judge.result } : {}),
    ...(judgeStaleSubject ? { judgeStaleSubject } : {}),
    ...(verify?.result ? { verifyResult: verify.result } : {}),
    failedAcceptance: failedAcceptance.length,
    failedVerifyAcceptance: failedVerifyAcceptance.length,
    reviewLoop,
    // **The reading that spans revisions, published beside the one that does not.** `reviewLoop` is scoped to the current
    // revision on purpose, so a repair — which necessarily issues a new revision — makes the previous rounds history about
    // something else, and the same problem returning for the fifth time reads as a loop that has measured nothing yet.
    // Measured downstream: eleven rounds, eleven revision ids, one blocking id in every one of them, and the only thing the
    // router could say was `no_current_rounds`. Read from the round history directly, because the identity it needs is not
    // the current one; `null` when the history is unreadable — that state has its own route, and reporting `[]` there would
    // be a claim about a file nobody could read.
    reviewLoopRecurrence: reviewRounds.kind === 'unreadable' ? null : recurrenceAcrossRevisions(reviewRounds.rounds),
    // **The class view travels beside the id view, because they answer different questions.** An id that comes back is almost
    // never; a *class* that comes back inside a previous repair is the shape this loop keeps paying for (measured: seven of
    // ten findings in one change were defects in the previous round's repair, while no id repeated). Reported, never enforced:
    // the operator sees which class is being sampled again and decides.
    reviewLoopClassRecurrence: reviewRounds.kind === 'unreadable' ? null : classRecurrence(reviewRounds.rounds),
    ...(reviewLoop.kind === 'stalled_current_rounds' ? {
      reviewEscalation: {
        rounds: reviewLoop.rounds,
        noProgressRounds: reviewLoop.noProgressRounds,
        blockingIds: reviewLoop.blockingIds,
      },
    } : {}),
    // **Each refusal comes from its own read.** These two were projections of `reviewLoop.kind`, which answers one value —
    // so with the pointer and the round log both unreadable only one of them was ever published, and an operator repairing
    // the first would meet the second on the next command. Routing still reads the assessment (the pointer's route outranks
    // the round history's); the facts are read from their own sources.
    ...(sealedRead.kind === 'unreadable' ? { currentRevisionUnreadable: sealedRead.detail } : {}),
    ...(reviewRounds.kind === 'unreadable' ? { reviewHistoryUnreadable: true } : {}),
    repairScopes: failedAcceptance.map((item) => item.repairScope).filter((scope): scope is RepairScope => Boolean(scope)),
    verifyRepairScopes: failedVerifyAcceptance.map((item) => item.repairScope).filter((scope): scope is RepairScope => Boolean(scope)),
    // **An unreadable round history is one state, and it is a refusal — not a measurement with a report beside it.**
    // This projection is read by routing through `reviewLoop.kind`, and a malformed line anywhere in the file makes the
    // whole record unreadable (`readReviewRoundsState` -> `{ kind: 'unreadable' }`), which `assessReviewLoop` returns as
    // `unreadable_round_history`: no count, no blocking ids, its own route. There is no assessment variant that carries a
    // measurement *and* `reviewHistoryUnreadable`, so a comment here claiming the damage is merely reported beside a
    // deciding measurement describes a state the code cannot represent — an independent review caught this file telling
    // the next reader the opposite of the pinned behaviour (`tests/unit/review-escalation-current-revision-route.test.ts`).
    wikiClosureValid: wikiClosure.valid,
    ...(!wikiClosure.valid ? { wikiClosureReason: wikiClosure.reason } : {}),
    ledger,
    evidenceFiles,
    // **The same answer the adequacy rule gives, not a third rule.** This counted `exitCode !== 0`, so a check declared
    // to exit 1 was counted as failing evidence here while `isPassing` called it proved — and `failingEvidence > 0` routes
    // the operator to `/kata-build` to fix a check that had already done what its declaration said.
    failingEvidence: evidence.filter((item) => item != null && !isPassing(item)).length,
    // **The closure question is answered by the ledger branch in `navigation`, not by a field here.**
    //
    // This used to publish a `roundClosure`/`ledgerClosure` verdict — `mayClose`, the unsupported claim ids and a reason —
    // and a route read it. The route was replaced by the ledger branch (`satisfy_ledger_deficits`, which asks the ledger's
    // own verdict and carries its deficits), and the field was kept as a report with nobody to report to: declared here,
    // written by two branches, read by no production code. Measured by grep, and by history — at the commit that replaced
    // the route the old field's reader was deleted in the same diff, which is how a field acquires a writer and loses its
    // reason to exist. The information survives where it is decided: `ledger.verdict` for the question, `ledger.deficits`
    // for what is missing, and `openLedgerProblems` for the claim ids.
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
  // Nothing routes out of archive: the change is being distilled, and the wiki/archive commands are the operator's.
  if (phase === 'archive') {
    return phaseFallbackAction('archive');
  }
  // The only review-loop route producer: each discriminated outcome names its own route.
  if (phase === 'review' && upstream.reviewLoop) {
    switch (upstream.reviewLoop.kind) {
      case 'unreadable_current_revision':
        return { nextSkill: '/kata-build', role: 'implementer', reason: 'repair_unreadable_current_revision', priority: 2300 };
      case 'unreadable_round_history':
        return { nextSkill: '/kata-build', role: 'implementer', reason: 'repair_unreadable_round_history', priority: 2290 };
      case 'unmeasurable_current_rounds':
        return { nextSkill: '/kata-review', role: 'reviewer', reason: 'review_loop_unmeasurable', priority: 2280 };
      case 'stalled_current_rounds':
        return {
          nextSkill: '/kata-review',
          role: 'reviewer',
          reason: 'escalate_review_without_progress',
          priority: 2200,
        };
      default:
        break;
    }
  }
  // **A record nobody can read outranks every report about the change.** This branch used to sit far below the loop
  // reports (change `1150`), so when a class recurred *and* the review record was unreadable the operator was sent to
  // `/kata-build` to mechanize a class instead of to `/kata-review` to re-read the record — measured by an independent
  // round. The rule the order now states: a refusal that names a precondition (make this readable) precedes any report
  // about the change, whatever priority the report carries.
  if (phase === 'review' && upstream.reviewRecordUnreadable) {
    return {
      nextSkill: '/kata-review',
      role: 'reviewer',
      reason: 'unreadable_review_record',
      priority: 2250,
    };
  }
  // **A class that came back inside a repair is routed, not merely published.** The first version of this published the
  // class view on the upstream summary and acted on nothing — the "computed, nobody reads it" shape this whole change exists
  // to close, measured by an independent round. It sits above the id-based route because a class recurring inside a repair
  // says more than one id repeating: the id view cannot see it at all (no id repeated across the seven rounds that produced
  // ten findings, seven of them in the previous round's repair).
  if (phase === 'review' && (upstream.reviewLoopClassRecurrence ?? []).some((entry) => entry.stopLineCandidate)) {
    const candidates = (upstream.reviewLoopClassRecurrence as ClassRecurrence[]).filter((entry) => entry.stopLineCandidate);
    return {
      nextSkill: '/kata-build',
      role: 'implementer',
      reason: 'review_class_recurring',
      priority: 2150 + candidates.length,
    };
  }
  // **A problem that survived a repair is worth another implementation pass, and it is a route rather than a gate change.**
  // It sits below the escalation above, so it can only speak where that produced nothing: the operator is told the same
  // finding keeps coming back even while each round's own count looks like steady progress. Nothing about what the gates
  // demand moved — a change that only recurs is still routed the way a change with a blocking finding always was.
  if (phase === 'review' && (upstream.reviewLoopRecurrence?.length ?? 0) > 0) {
    return {
      nextSkill: '/kata-build',
      role: 'implementer',
      reason: 'review_loop_recurring',
      priority: 2100 + (upstream.reviewLoopRecurrence as ReviewRecurrence[]).length,
    };
  }
  // Evidence from more than one revision cannot be judged together, so the seal that produced it is redone first.
  if (upstream.mixedRevisionEvidence) {
    return {
      nextSkill: '/kata-build',
      role: 'implementer',
      reason: 'repair_mixed_revision_evidence',
      priority: 2100,
    };
  }
  // **The ledger's own decision is the authority when the change has one.** It accounts for evidence strength, stale
  // verdicts, open counterexamples and the discovery floor in one place, where the branches below count findings — and
  // counting findings is the part this replaces. It sits below the two state gates above it (mixed-revision evidence,
  // an unreadable current revision), because those make every piece of evidence meaningless rather than merely
  // insufficient.
  //
  // **The obligation gate is gone, and this branch answers the question it asked.** That gate read "is there a recorded
  // failure not yet answered", which a judge FAIL used to satisfy by writing an obligation — and judge can no longer be
  // reached without a ledger, so nothing creates one for a governed change any more (measured: the only writer of an
  // approved review refuses ledger-less changes, and judge refuses unapproved reviews). The failure is not lost: it
  // lives where the failing criterion lives, as a claim whose evaluation is a verdict, and an unsupported claim is what
  // this branch routes on. Legacy acceptance matrices keep their own branch below, because "the matrix was never
  // declared" is a property of the task rather than of an obligation.
  if (upstream.ledger && upstream.ledger.state === 'decided' && upstream.ledger.verdict !== 'pass') {
    return {
      nextSkill: '/kata-build',
      role: 'implementer',
      reason: 'satisfy_ledger_deficits',
      priority: 1990 + upstream.ledger.deficits.length,
    };
  }
  // A ledger that exists and cannot be read is a refusal, not an absence: falling through would let the round-shaped
  // branches decide as if nothing were wrong.
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
  // A failed verify is repaired before review findings are read: the findings were formed against content that no longer stands.
  if (phase === 'review' && upstream.verifyResult === 'FAIL') {
    return {
      nextSkill: '/kata-build',
      role: 'implementer',
      reason: verifyRepairReason(upstream),
      priority: 1020 + upstream.failedVerifyAcceptance,
    };
  }
  // **A record nobody can read is not a record that found nothing.** This used to be *reported* on the summary
  // (`reviewRecordUnreadable`) and read by nobody, while the problems list fell back to empty — so a change whose review
  // record was unreadable was routed to the judge exactly as if the review had been clean. An unreadable record is a
  // refusal, and the step it refuses towards is a re-read of the review, not a judgement of the change.

  // **One ladder, read twice.** The severities that block come from `mergeBlockingSeverities`, ordered hardest first,
  // so position 0 is the severity every mode refuses and position 1 is the one only the tiers above std do. This used
  // to be two blocks of prose plus a `=== 'strict'` literal, which is why `security` — a tier the kernel gives two
  // reviewers and always-on quorum — blocked on *less* than the tier below it.
  const blockingSeverities = mergeBlockingSeverities(upstream.reviewMode);
  const hardestSeverity = blockingSeverities[0];
  // An open problem at the tier's bar is repaired, not argued with.
  if (phase === 'review' && upstream.blockingFindings > 0) {
    return {
      nextSkill: '/kata-build',
      role: 'implementer',
      reason: 'repair_blocking_review_findings',
      priority: 1000 + upstream.blockingFindings,
    };
  }
  // `strict` blocks on major findings too; a weaker tier reports them without opening a repair, which is why the list is asked for rather than assumed.
  if (phase === 'review' && blockingSeverities.length > 1 && upstream.majorFindings > 0) {
    return {
      nextSkill: '/kata-build',
      role: 'implementer',
      reason: 'repair_strict_major_findings',
      priority: 980 + upstream.majorFindings,
    };
  }
  // An approval with no review evidence is not an approval: the record says a judgement was made and nothing says what on.
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
  // A judge FAIL whose failed criteria are repairable goes back to implementation rather than to another judge.
  if (phase === 'judge' && upstream.judgeResult === 'FAIL') {
    return {
      nextSkill: '/kata-build',
      role: 'implementer',
      reason: 'repair_failed_judge',
      priority: 900 + upstream.failedAcceptance,
    };
  }
  // A check that exited non-zero is evidence against the change, whatever the verdict files say.
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
  // A verify FAIL repairs the acceptance criteria it named, once the uniform-scope case above did not apply.
  if (phase === 'hardVerify' && upstream.verifyResult === 'FAIL') {
    // A verify that failed because its evidence predates the content is not repaired by arguing with the verdict: the
    // evidence is re-read against what is on disk now, which is what `--seal` does. The note that used to stand here said
    // "in review phase" and described a priority over review findings — a branch that no longer exists, in a phase this
    // one is not.
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
  // A passing verify is what makes a review possible, so the next step is the review.
  if (phase === 'hardVerify' && upstream.verifyResult === 'PASS') {
    return { nextSkill: '/kata-review', role: 'reviewer', reason: 'review_fresh_implementation', priority: 740 };
  }
  // A hardVerify change with no recorded verdict has not been verified yet.
  if (phase === 'hardVerify') {
    return phaseFallbackAction('hardVerify');
  }
  // In review, a readable record with no open problem is ready for its conclusion.
  if (phase === 'review') {
    return phaseFallbackAction('review');
  }
  // Past the judge, the remaining work is the operator's: inspect and archive.
  if (phase === 'judge' || phase === 'distill') {
    return phaseFallbackAction('judge');
  }
  // Before the first seal there is nothing to inspect but the task's own declaration.
  if (phase === 'plan' || phase === 'implement' || phase === 'intake') {
    return phaseFallbackAction(phase);
  }
  // **The duplicate of this branch was deleted, not left as documentation.** It sat below the `plan`/`implement`/`intake`
  // branch, which cannot reach it (`phase === 'review'` is caught two branches above), and it carried a copy of the note
  // that explains the earlier one — so a scan for "every branch says why it returns" counted it as documented while it
  // could never return. An independent reading measured exactly that; dead code with a comment reads as a live branch.
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
    // The escalation is a decision, not a dispatch: it stops with or without a model trust boundary, because the next
    // step is a person deciding whether to keep repairing, waive a problem, or stop the change.
    requiresUserConfirmation: gate !== null || wikiClosure || reason === 'escalate_review_without_progress' || reason === 'review_loop_unmeasurable',
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
            pauseInstruction: `${gate ? boundaryPromptFor(gate, promptLanguage()) : ''} 进入 review 后要跑两条命令：\`kata-cli review --change ${taskId}\` 先把相位推进 review，然后 \`kata-cli review --change ${taskId} --approve --review-evidence "<本轮结论依据>"\` 记录结论——第一条在相位推进前会被拒绝，第二条属于记录结论，不再要求已经用掉的门禁。`,
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
  // Not a model boundary: this one stops for a decision about the change, not about which platform runs next.
  escalate_review_without_progress: null,
  review_loop_unmeasurable: null,
  // Not a model boundary either: it is a decision about the change, and the gates it passes through are unchanged.
  review_loop_recurring: null,
  // A class recurring inside a repair routes through the build entry, not through a gate: nothing about what the gates
  // demand changes, the operator is told which class keeps being paid for.
  review_class_recurring: null,
  // Also a decision about the change rather than about which platform runs: the record has to be read again.
  unreadable_review_record: null,
  repair_unreadable_current_revision: null,
  repair_unreadable_round_history: null,
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

// **`readJsonFile` was here**, and its whole body was the defect this change closes: `catch { return null }` answered the
// same value for ENOENT, a parse error and a permission failure, so every one of its callers reported "nothing here" for a
// file an operator had to repair. `readRecordState` (`core/record-read.ts`) is the reader that tells them apart.

async function listEvidenceFiles(root: string, taskId: string): Promise<string[]> {
  {
    const evidenceDirectory = layoutEvidenceDir(root);
    // **The listing is the one thing here that can fail as a whole, and `[]` is a claim about the store.** `ENOENT` means this
    // task has recorded no evidence yet, which is a state; every other failure means the directory is there and cannot be
    // listed, which is a refusal that has to name the directory — the per-file reads below already keep their unreadable
    // entries, so folding only this one into an empty set was the remaining place a reader could not tell the two apart.
    const listing = await readDirectoryState(evidenceDirectory);
    if (listing.kind === 'unreadable') {
      throw new Error(`Cannot list the recorded evidence for ${taskId}: ${listing.detail}. Repair the directory; a store that cannot be listed is not an empty one.`);
    }
    const candidates = (listing.kind === 'usable' ? listing.entries : [])
      .filter((file) => file.startsWith(`${taskId}-`) && file.endsWith('.json'));
    const matches = await Promise.all(candidates.map(async (file) => ({
      file,
      read: await readRecordState<{ taskId?: string }>(join(evidenceDirectory, file)),
    })));
    return matches
      // **A file that cannot be read is kept, not dropped.** Its name already attributes it to this task, and dropping it
      // was the same defect one layer up: the summary reported a set that did not match the directory, with nothing to
      // reconcile it against. Only an `absent` entry is dropped — a file that vanished between the listing and the read.
      .filter(({ read }) => read.kind === 'unreadable' || (read.kind === 'usable' && read.value.taskId === taskId))
      .map(({ file }) => file)
      .sort();
  }
}
