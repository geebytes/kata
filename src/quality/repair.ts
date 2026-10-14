import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { taskDir } from '../core/layout.js';
import { assertTaskLock, withTaskLock, type TaskLock } from '../core/state.js';
import type { Phase } from '../core/state.js';
import type { ReviewSeverity } from './reviewer.js';
import { isDefectClass, oracleFor } from './defect-classes.js';
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

/**
 * Why a repair was opened. One union for the record: the seal path, the reviewer-repair authorization and the repair
 * gate all read it, and each entry phase writes one member of it.
 */
export type RepairReason =
    | 'review_findings'
    | 'revision_superseded'
    | 'judge_fail'
    | 'verify_fail'
    | 'verify_reseal'
    // A ledger that asks the author for something (`challenge_open`, an unsupported claim) routes to `/kata-build`
    // with no gate, so the authoriser has to accept that entry — otherwise the remedy the router names cannot be
    // executed by the command it names.
    | 'ledger_deficits';

/** The repair artefact. Unknown fields are preserved: the resolution path spreads the record it read. */
export interface RepairRecordShape {
  taskId: string;
  fromPhase: Phase;
  toPhase: 'implement';
  actor: { id: string; role: string; platform?: string };
  reason: RepairReason;
  /** The review findings that authorised the repair, in the producer's shape. */
  findings?: Array<{ id?: string; acceptanceId?: string; severity?: string; message?: string; path?: string }>;
  scopes?: Array<{ id?: string; repairScope?: string }>;
  baselineRevisionId?: string;
  baselineManifestHash?: string;
  createdAt: string;
  resolvedAt?: string;
  resolvedRevisionId?: string;
  [key: string]: unknown;
}

/** What an authorized repair entry carries, before the transition stamps the task, actor and time onto it. */
export interface RepairPayload {
  fromPhase?: Phase;
  reason: RepairReason;
  findings?: Array<{ title?: string; message?: string; fix?: string }>;
  scopes?: Array<{ id?: string; repairScope?: string }>;
  baselineRevisionId?: string;
  baselineManifestHash?: string;
}

/**
 * One review-to-repair round, as it was opened.
 *
 * `repair.json` records the repair in flight and is overwritten by the next one, so the loop's history had nowhere to
 * live. Without it nothing could ask whether the repairs were reducing the problems they were opened for, and the loop
 * had no terminal state: review → repair → review could continue indefinitely, each round justified on its own terms.
 */
/**
 * The part of a finding a round record keeps: enough to read the class of defect and whether the defect was in the original
 * code or in a previous repair, without copying the whole message into an append-only file.
 */
export interface RoundFinding {
    id: string;
    severity: string;
    /** The defect class (`src/quality/defect-classes.ts`), when the round recorded one. */
    class?: string;
    /** `original` or `repair` — whether this defect was found in the code or in a previous round's repair. */
    origin?: string;
}

export interface ReviewRound {
    at: string;
    /**
     * The sealed revision this round measured, and the content identity sealed with it.
     *
     * **Both, not just the id.** A re-seal of byte-identical content issues a new revision id, and the content hash is
     * what says the round is still about the same work — the same pairing the verdicts and the gate records use.
     *
     * **Absent on legacy lines**, which were written before a round could name a revision. They stay readable and are
     * treated as what they are: history that cannot claim the current revision.
     */
    revisionId?: string;
    manifestHash?: string;
    /**
     * The revision this round *reviewed*, when that is not the revision it is recorded against.
     *
     * The id above describes the content the round is bound to; this names the revision the round was opened against.
     * Entering review writes a placeholder bound to the revision in hand and the round reviews that content, so when the
     * pointer has moved by the time the result arrives the two differ — and a reader can then tell a round recorded after
     * the content moved from one that answered the content in hand. Absent on lines written before the field existed.
     */
    reviewedRevisionId?: string;
    /** The problems the round was opened for, by id — the escalation names these rather than a count alone. */

    /**
     * **The round's findings, not only their ids.** The row used to carry `blockingIds` and a count, so the history of 102
     * rounds in this repository survives as 56 findings: `review.json` is overwritten by the next round and the row kept
     * nothing else. A reader could see that a round found three blockers and never what they were, which is exactly the
     * reading that says whether the loop is converging or recycling its own repairs.
     *
     * Optional in the type because rows written before the field existed stay readable — and a *new* row is refused by name
     * when its findings could not be read (see `appendReviewRound`'s caller in the repair entry).
     */
    findings?: RoundFinding[];
    /** Why a round has no findings to record (an approval that measured zero, or a repair admitted for ledger deficits). */
    noFindings?: string;
    blockingIds: string[];
    /**
     * How many problems blocked when the round was opened.
     *
     * **`null` when the round could not be measured** — never `0`, which would read as "this round reduced the
     * problems to none". A repair opened only because the sealed revision was superseded has nothing to count, and
     * saying so is different from saying nothing was blocking.
     */
    blockingCount: number | null;
}

/**
 * How many consecutive rounds without a reduction of the blocking count stop the loop.
 *
 * **Counted in rounds that did not reduce**, so a flat history escalates on the round after these: four recorded rounds
 * for the first escalation, not three. The sentence and the loop have to agree on that, because an off-by-one between two
 * readings of "three rounds" is a defect that hides in the gap between them — `reviewProgress` returns the trailing run so
 * a caller can see which reading it got.
 *
 * A judgement, not a measurement, so it is a named constant the escalation reports rather than a number buried in a
 * comparison: the caller can disagree with it, and a reader can see what was assumed.
 */
export const NO_PROGRESS_ROUNDS = 3;

export interface ReviewProgress {
    /**
     * The rounds the judgment was made of, measured or not.
     *
     * With an identity: the rounds of that revision. A line bound to another revision is history about something else,
     * and one that names no revision cannot claim this one. Without one: every round given, because the caller is then
     * stating that those rounds are the set in question — the routing surface, which can fail to read the sealed
     * pointer, does not take that route and reports the damage instead of a verdict.
     */
    rounds: number;
    /** The trailing run of rounds that did not reduce the count. */
    noProgressRounds: number;
    escalating: boolean;
    /** What the newest measured round was opened for. Empty when no round measured anything. */
    blockingIds: string[];
    /** Rounds that recorded no count, reported rather than dropped: an unmeasured round is not an improvement. */
    unmeasuredRounds: number;
    /**
     * True when the history exists but **nothing** in it could be measured.
     *
     * A loop that cannot be judged must not read as a loop that is fine: with every line unmeasurable, `noProgressRounds`
     * is 0, which is indistinguishable from a change whose first round went perfectly. The state is named so the escalation
     * can say which of the two it is, and it escalates, because the alternative is to keep dispatching repairs on the
     * strength of a history nobody can read.
     */
    unmeasurable: boolean;
}

export interface ReviewLoopIdentity {
    revisionId: string;
    manifestHash: string;
}

/** One explicit record-state snapshot is the input to every review-loop verdict. */
export interface ReviewLoopAssessmentInput {
    currentRevision:
        | { kind: 'absent' }
        | { kind: 'unreadable'; detail: string }
        | { kind: 'current'; identity: ReviewLoopIdentity };
    reviewRounds: ReviewRoundsRead;
}

/**
 * The complete, mutually-exclusive answer to whether the review loop may affect routing.
 *
 * Seven variants, and `stalled_current_rounds` is deliberately the only one that escalates:
 * every other kind names a state of its own.  Missing or unreadable artefacts name the refusal that was
 * observed instead of borrowing the semantics of a zero-count escalation.
 */
export type ReviewLoopAssessment =
    | { kind: 'not_applicable'; reason: 'no_current_revision' }
    | { kind: 'unreadable_current_revision'; detail: string }
    | { kind: 'unreadable_round_history'; detail: string }
    | { kind: 'no_current_rounds' }
    | { kind: 'unmeasurable_current_rounds'; rounds: number; roundIds: readonly string[] }
    | { kind: 'progressing_current_rounds'; rounds: number; noProgressRounds: number }
    | { kind: 'stalled_current_rounds'; rounds: number; noProgressRounds: number; blockingIds: readonly string[] };

export function reviewRoundsPath(root: string, taskId: string): string {
    return join(taskDir(root, taskId), 'review-rounds.jsonl');
}

/**
 * Derive the loop's progress from the recorded rounds.
 *
 * Only rounds that measured a count participate in the comparison, and a run of rounds that **left work behind** is what
 * escalates: a round that measured zero cleared the loop, and a round that measured nothing can neither be progress nor
 * be read as one.
 */
/**
 * **Whether a recorded round measured the revision being judged.**
 *
 * Exported because the rule is what a counterexample has to aim at: a probe that mutates this file's *shape* proves
 * nothing about the rule, and one that mutates this function proves exactly the rule. It also keeps a single spelling of
 * "this round is about that revision" rather than the same conjunction repeated at every call site.
 *
 * A legacy line names no revision. It cannot claim the current one, so it does not measure it — and it is dropped from
 * the comparison while staying in the file, which is the difference between "history nobody can read" and "history about
 * something else".
 */
export function roundBoundTo(
    round: ReviewRound,
    currentRevision: { revisionId: string; manifestHash: string },
): boolean {
    return round.revisionId === currentRevision.revisionId && round.manifestHash === currentRevision.manifestHash;
}

/**
 * One problem, and the revisions it was recorded against.
 *
 * `revisions` is sorted and de-duplicated; a finding whose list has one entry did not recur.
 */
export interface ReviewRecurrence {
    id: string;
    revisions: string[];
}

/**
 * Findings that came back after a repair, read across revisions rather than inside one.
 *
 * **This is the reading the current-revision count cannot produce, and its absence is why the loop never converged.**
 * `assessReviewLoop` scopes the rounds to the current revision — deliberately, because "a round about other content is not
 * a reading of this content". But a repair *produces* a new revision: entering review after a repair writes a placeholder
 * bound to the new one, so the rounds of the previous revision are history about something else, `scopedRounds` is empty
 * or thin, and the same problem being found for the fifth time reads as a loop that has not measured anything yet
 * (measured downstream: eleven rounds, eleven distinct revision ids, every one of them recording `R2R12-F1`, and the only
 * thing the router could say was `no_current_rounds`).
 *
 * **What it is not.** It is not a gate and it does not replace the escalation: a problem found again after a repair is a
 * fact for the operator and for routing, and the count that decides whether a loop is stuck stays where it was — computed
 * over one revision, because "this revision's problems are not falling" and "this problem keeps coming back" are two
 * different sentences about two different sets.
 *
 * The identity compared is the revision the round **reviewed** (`reviewedRevisionId`), falling back to the one it is
 * recorded against — a round that was opened against content the pointer later moved away from is evidence about the
 * content it read, and that is the content a repair was made of. A line naming neither revision contributes to a bucket
 * called `unnamed revision`, which is what it is: history that cannot say which content it read, and recurrence against it
 * is still recurrence (the problem outlived a repair either way).
 */
/**
 * **The same recurrence, counted by defect class instead of by finding id — and split by what it says about the process.**
 *
 * Counting by id answers "has this exact finding come back", which is almost never: a repair rewrites a defect and the next
 * round finds a *different* one of the *same class*. Measured on one change: seven rounds, ten findings, and seven of those
 * ten were defects in the previous round's repair (rounds 4, 6 and 7 each found one in the round before them) — while the
 * id-based view reported nothing recurring, because no id repeated.
 *
 * Two refinements carry the signal, both required:
 *
 * - **`mechanizable` only.** A `judgment` class recurring is normal — two independent rounds can each find a distinct intent
 *   omission, which is the instrument working. Escalating on that would be a false stop.
 * - **`origin: repair` required.** The bad shape is not "the class appeared again" but "the class appeared again inside a
 *   previous repair" — that is the loop recycling its own fixes instead of converging.
 *
 * `stopLineCandidate` is a *report*: neither this function nor its caller refuses a round (that would change what a gate
 * permits). It names the class, the rounds and the repair-origin count so the operator can decide.
 */
export interface ClassRecurrence {
    class: string;
    oracle: 'mechanizable' | 'judgment';
    /** The `at` of every round this class appeared in, oldest first. */
    rounds: string[];
    /** The ids of the findings, so the class view never hides the instances it is made of. */
    findings: string[];
    /** How many of those findings were defects in a previous round's repair. */
    repairOrigin: number;
    /** A mechanizable class that came back inside a repair: the shape worth stopping for, reported and not enforced. */
    stopLineCandidate: boolean;
}

export function classRecurrence(rounds: readonly ReviewRound[]): ClassRecurrence[] {
    const byClass = new Map<string, { rounds: string[]; findings: string[]; repairOrigin: number }>();
    for (const round of rounds) {
        for (const finding of round.findings ?? []) {
            if (typeof finding.class !== 'string' || finding.class === '') continue;
            const entry = byClass.get(finding.class) ?? { rounds: [], findings: [], repairOrigin: 0 };
            if (!entry.rounds.includes(round.at)) entry.rounds.push(round.at);
            if (!entry.findings.includes(finding.id)) entry.findings.push(finding.id);
            if (finding.origin === 'repair') entry.repairOrigin += 1;
            byClass.set(finding.class, entry);
        }
    }
    return [...byClass.entries()]
        .filter(([, entry]) => entry.rounds.length > 1)
        .map(([name, entry]) => {
            const oracle = isDefectClass(name) ? oracleFor(name) : 'judgment';
            return {
                class: name,
                oracle,
                rounds: [...entry.rounds].sort(),
                findings: [...entry.findings].sort(),
                repairOrigin: entry.repairOrigin,
                stopLineCandidate: oracle === 'mechanizable' && entry.repairOrigin > 0 && entry.rounds.length > 1,
            };
        })
        .sort((left, right) => Number(right.stopLineCandidate) - Number(left.stopLineCandidate) || left.class.localeCompare(right.class));
}

export function recurrenceAcrossRevisions(rounds: readonly ReviewRound[]): ReviewRecurrence[] {
    const revisionsById = new Map<string, Set<string>>();
    for (const round of rounds) {
        const revision = round.reviewedRevisionId ?? round.revisionId ?? 'unnamed revision';
        for (const id of round.blockingIds) {
            const revisions = revisionsById.get(id) ?? new Set<string>();
            revisions.add(revision);
            revisionsById.set(id, revisions);
        }
    }
    return [...revisionsById.entries()]
        .filter(([, revisions]) => revisions.size > 1)
        .map(([id, revisions]) => ({ id, revisions: [...revisions].sort() }))
        .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Measure the already-scoped set it is handed — never an identity, and a missing identity is never permission to
 * measure a whole history.
 *
 * **Exported for its own tests and for no production consumer but the evaluator.** The only caller in `src/` is
 * `assessReviewLoop`, which passes `scopedRounds`; the absence of an identity parameter is the contract, so a caller
 * that wants a verdict about *some* revision must go through `assessReviewLoop` and its filter. Kept as a public
 * function because the escalation arithmetic is worth testing on its own, which is a testing affordance and not a
 * second production entry point (an independent review flagged it as a latent bypass; this is the recorded reason it
 * stays, and `tests/unit/one-derivation-or-none` style checks pin the routing side).
 */
export function reviewProgress(rounds: readonly ReviewRound[]): ReviewProgress {
    const currentRounds = rounds;
    // **Progress is measured against the best count reached so far, not against the round before it.** An oscillating
    // loop (5 → 4 → 5 → 4 → …) reads as progress at every single step under the neighbouring comparison, and it is
    // plainly stuck: it has not reached a new low since round 2. A loop that only ever gets worse is the same fact with
    // the sign flipped, and both must escalate.
    let best: number | null = null;
    let noProgressRounds = 0;
    let unmeasuredRounds = 0;
    let newestMeasuredIds: string[] = [];
    for (const round of currentRounds) {
        if (round.blockingCount === null) {
            // **Neutral, and counted.** A round that measured nothing is neither progress nor a failure to progress, so it
            // neither resets the run nor extends it; `unmeasuredRounds` reports it, because a history that could not be
            // measured at all must not read as a healthy loop.
            unmeasuredRounds += 1;
            continue;
        }
        newestMeasuredIds = [...round.blockingIds];
        // **A cleared round is the goal state, not a round that failed to improve.** Nothing left to reduce means the run
        // ends; keeping it open would make a loop that reached zero look like one that stalled on zero. (Zero is the
        // writer's job to record — see `recordReviewRound`; a round that merely *could not* be measured is `null` and stays
        // neutral below.)
        if (round.blockingCount === 0) {
            best = 0;
            noProgressRounds = 0;
            continue;
        }
        if (best === null || best === 0 || round.blockingCount < best) {
            best = round.blockingCount;
            noProgressRounds = 0;
        } else {
            noProgressRounds += 1;
        }
    }
    // **Every aggregate is about the rounds being judged, not about the file.** These three facts were computed from
    // `rounds.length` while the loop above walked `currentRounds`, so one line from another revision changed the
    // judgment: the same current-revision history read `escalating: true` alone and `escalating: false` with a single
    // foreign line prefixed to it. A count that describes the judgment has to come from the set the judgment used.
    const measurable = currentRounds.length - unmeasuredRounds;
    const unmeasurable = currentRounds.length > 0 && measurable === 0;
    return {
        rounds: currentRounds.length,
        noProgressRounds,
        escalating: noProgressRounds >= NO_PROGRESS_ROUNDS || unmeasurable,
        blockingIds: newestMeasuredIds,
        unmeasuredRounds,
        unmeasurable,
    };
}

/** Derive the one review-loop outcome that routing is permitted to consume. */
export function assessReviewLoop(input: ReviewLoopAssessmentInput): ReviewLoopAssessment {
    if (input.currentRevision.kind === 'unreadable') {
        return { kind: 'unreadable_current_revision', detail: input.currentRevision.detail };
    }
    if (input.currentRevision.kind === 'absent') {
        return { kind: 'not_applicable', reason: 'no_current_revision' };
    }
    if (input.reviewRounds.kind === 'unreadable') {
        return { kind: 'unreadable_round_history', detail: input.reviewRounds.detail };
    }

    const identity = input.currentRevision.identity;
    const scopedRounds = input.reviewRounds.rounds.filter((round) => roundBoundTo(round, identity));
    if (scopedRounds.length === 0) return { kind: 'no_current_rounds' };

    const progress = reviewProgress(scopedRounds);
    if (progress.unmeasurable) {
        return {
            kind: 'unmeasurable_current_rounds',
            rounds: progress.rounds,
            roundIds: scopedRounds.map((round) => round.at),
        };
    }
    if (progress.escalating) {
        return {
            kind: 'stalled_current_rounds',
            rounds: progress.rounds,
            noProgressRounds: progress.noProgressRounds,
            blockingIds: progress.blockingIds,
        };
    }
    return {
        kind: 'progressing_current_rounds',
        rounds: progress.rounds,
        noProgressRounds: progress.noProgressRounds,
    };
}

/**
 * Record a round under the task's single-writer lock, one line per round.
 *
 * Append-only, because the history is the point: a record the next repair overwrites cannot say whether the loop is
 * moving. The lock is the repository's one rule for task artefacts, and this file keeps a single write entry point so
 * there is no second, unlocked way in.
 */
/**
 * **What a round row's `findings` means, defined once.**
 *
 * The writer's guard and the reader's projection must agree on what "this row carries findings" means, or a row the writer
 * accepted reads back as `unavailable`. The guard measured `length`; the reader kept only entries with a string `id` and
 * `severity` — so a non-array, or entries the reader drops, slipped through, and the history said a round happened and not
 * what it found. One predicate, used by both.
 */
export function readableRoundFindings(value: unknown): RoundFinding[] {
    if (!Array.isArray(value)) return [];
    return (value as unknown[])
        .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && !Array.isArray(entry))
        .filter((entry) => typeof entry.id === 'string' && typeof entry.severity === 'string')
        .map((entry) => ({
            id: entry.id as string,
            severity: entry.severity as string,
            ...(typeof entry.class === 'string' ? { class: entry.class } : {}),
            ...(typeof entry.origin === 'string' ? { origin: entry.origin } : {}),
        }));
}

export async function appendReviewRound(root: string, taskId: string, round: ReviewRound, lock?: TaskLock): Promise<void> {
    // **A round that records no findings says so, and is never silently id-only.** The caller has to pass the findings it read
    // (possibly an empty list — an approval measured zero) or an explicit `noFindings` reason, so "the record could not be
    // read" cannot arrive here disguised as "the round found nothing". Measured shape this refuses: the old row recorded
    // `blockingIds` and a count, which is indistinguishable from a round whose findings nobody kept.
    // **Empty is not a reason.** `findings: []` with no `noFindings` reads back as `unavailable` — the same
    // "nobody kept what it found" ambiguity this rule exists to refuse, reached through the empty-array door (measured by
    // an independent round).
    // **The guard asks the same predicate the reader does.** It measured `findings.length`, while the reader kept only
    // entries carrying an `id` and a `severity` — so a non-array, or an array of entries the reader drops, passed the guard
    // and read back as `unavailable`, which is the ambiguity this rule exists to refuse (measured by an independent round).
    if (readableRoundFindings(round.findings).length === 0 && round.noFindings === undefined) {
        throw new Error(
            `refusing to record the round at ${round.at}: it carries no findings and no reason for having none, so the history `
            + 'would say a round happened and not what it found — pass the findings the round recorded, or `noFindings` with the reason',
        );
    }
    const path = reviewRoundsPath(root, taskId);
    // The directory before the lock: this is the first write of a round, and a task that has not written anything yet has
    // no directory for the lock's own file to live in.
    await mkdir(dirname(path), { recursive: true });
    const append = async () => {
        await appendFile(path, `${JSON.stringify(round)}\n`, 'utf8');
    };
    if (lock) {
        assertTaskLock(lock, root, taskId);
        await append();
        return;
    }
    await withTaskLock(root, taskId, async () => append());
}

export type ReviewRoundsRead =
    | { kind: 'absent'; rounds: ReviewRound[] }
    | { kind: 'readable'; rounds: ReviewRound[] }
    | { kind: 'unreadable'; rounds: ReviewRound[]; detail: string };

/**
 * Read the recorded rounds, oldest first.
 *
 * A line that cannot be parsed becomes an **unmeasured round** rather than being dropped. Both readings leave
 * `reviewProgress`'s trailing run identical — an unmeasured round is neutral there — so the difference is what the
 * history *says about itself*: `rounds` and `unmeasuredRounds` count a damaged line, and a dropped one would leave the
 * file looking shorter than it is. An absent file is an empty history — a change under its first repair has no rounds
 * yet — and that is the only case that reads as nothing was ever recorded.
 */
/**
 * Whether a parsed line is a review round.
 *
 * The fields the reader uses, and their types: a bare number, an array, or an object without `at` and `blockingIds` is not
 * a round, and reading one as a round is how a corrupt file becomes a history with rounds in it.
 */
function isRoundRecord(value: unknown): value is {
    at: string;
    blockingIds: unknown[];
    blockingCount?: unknown;
    revisionId?: unknown;
    manifestHash?: unknown;
    reviewedRevisionId?: unknown;
    findings?: unknown;
    noFindings?: unknown;
} {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return typeof record.at === 'string'
        && Array.isArray(record.blockingIds)
        && (record.revisionId === undefined || typeof record.revisionId === 'string')
        && (record.manifestHash === undefined || typeof record.manifestHash === 'string')
        && (record.reviewedRevisionId === undefined || typeof record.reviewedRevisionId === 'string');
}

export async function readReviewRoundsState(root: string, taskId: string): Promise<ReviewRoundsRead> {
    let raw: string;
    try {
        raw = await readFile(reviewRoundsPath(root, taskId), 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent', rounds: [] };
        return { kind: 'unreadable', rounds: [], detail: (error as Error).message };
    }
    const rounds: ReviewRound[] = [];
    let malformedLine: number | undefined;
    const lines = raw.split('\n').filter((line) => line.trim() !== '');
    for (const line of lines) {
        try {
            const parsed = JSON.parse(line) as unknown;
            // **A record that parses but is not a round is malformed, not a round.** `JSON.parse` answers for `42`, `{}`
            // and `[]` alike, and the previous version pushed all three as rounds — so a file of numbers read as a
            // history of unmeasured rounds and the loop's escalation counted rounds it never had. Shape and parse are two
            // facts, and only the first is about the record.
            if (!isRoundRecord(parsed)) {
                // **Counted as damage, not as a round.** This used to push a placeholder, so a file with one damaged line
                // reported one more round than it had, and the loop's escalation counted rounds nobody recorded. The route
                // no longer runs through that path at all: a malformed line anywhere makes the whole record
                // `{ kind: 'unreadable' }`, which `assessReviewLoop` answers as `unreadable_round_history` without calling
                // `reviewProgress` — so `navigation` never feeds these rounds anywhere. The parseable prefix stays, for
                // diagnosis; the count does not grow for a line that is not a round.
                malformedLine ??= lines.filter((candidate) => candidate.trim() !== '').indexOf(line) + 1;
                continue;
            }
            rounds.push({
                at: parsed.at,
                ...(typeof parsed.revisionId === 'string' ? { revisionId: parsed.revisionId } : {}),
                ...(typeof parsed.manifestHash === 'string' ? { manifestHash: parsed.manifestHash } : {}),
                ...(typeof parsed.reviewedRevisionId === 'string' ? { reviewedRevisionId: parsed.reviewedRevisionId } : {}),
                blockingIds: parsed.blockingIds.filter((id): id is string => typeof id === 'string'),
                blockingCount: typeof parsed.blockingCount === 'number' ? parsed.blockingCount : null,
                // **What the round found, when the row kept it.** Rows written before the field existed simply have nothing
                // here, and that is reported by its absence rather than filled in with a guess: a history that cannot be read
                // is a worse outcome than an incomplete one.
                ...(readableRoundFindings(parsed.findings).length > 0 ? { findings: readableRoundFindings(parsed.findings) } : {}),
                ...(typeof parsed.noFindings === 'string' ? { noFindings: parsed.noFindings } : {}),
            });
        } catch {
            malformedLine ??= lines.filter((candidate) => candidate.trim() !== '').indexOf(line) + 1;
        }
    }
    if (malformedLine !== undefined) {
        return { kind: 'unreadable', rounds, detail: `review-rounds history has malformed JSONL at record ${malformedLine}` };
    }
    return { kind: 'readable', rounds };
}

// **The deprecated wrapper is gone, not kept.** It existed for callers that only wanted the list, and once the router
// moved to `readReviewRoundsState` that left it with test-only consumers — the single unreferenced export in `src/`, which
// this repository's own wiring check reports. A reader whose `kind` is dropped at the call site is the defect this change
// exists to remove, so the convenience wrapper that dropped it is not a convenience.
