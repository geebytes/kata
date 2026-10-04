import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { taskDir } from '../core/layout.js';
import { withTaskLock } from '../core/state.js';
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
    /** The problems the round was opened for, by id — the escalation names these rather than a count alone. */
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

export function reviewProgress(
    rounds: readonly ReviewRound[],
    currentRevision?: { revisionId: string; manifestHash: string },
): ReviewProgress {

    // **Only the current revision's rounds are measured, and an unbound line is not one of them.** Before this the whole
    // file was one loop: a round recorded against a revision that had already been superseded kept escalating against
    // the next one, so a fresh, clean revision inherited a stalled history it had nothing to do with.
    //
    // **A missing identity is a caller saying "these rounds are all I have", not "judge everything".** `undefined` used
    // to mean the whole file, and the routing surface — which can *fail* to read the sealed pointer — passed it, so a
    // corrupted `current-revision.json` handed the escalating verdict to another revision's history (reproduced: four
    // prior-revision rounds, pointer `{`, route `escalate_review_without_progress`). The surface that cannot name a
    // revision no longer asks this function to judge one: it checks the file is readable and reports the damage, and
    // leaves the escalation unset (`navigation.ts`). So `undefined` keeps its literal meaning — the rounds given are the
    // set to judge — and the defect is closed where the identity was lost rather than by blanking a legitimate caller.
    const currentRounds = currentRevision === undefined
        ? rounds
        : rounds.filter((round) => roundBoundTo(round, currentRevision));
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

/**
 * Record a round under the task's single-writer lock, one line per round.
 *
 * Append-only, because the history is the point: a record the next repair overwrites cannot say whether the loop is
 * moving. The lock is the repository's one rule for task artefacts, and this file keeps a single write entry point so
 * there is no second, unlocked way in.
 */
export async function appendReviewRound(root: string, taskId: string, round: ReviewRound): Promise<void> {
    const path = reviewRoundsPath(root, taskId);
    // The directory before the lock: this is the first write of a round, and a task that has not written anything yet has
    // no directory for the lock's own file to live in.
    await mkdir(dirname(path), { recursive: true });
    await withTaskLock(root, taskId, async () => {
        await appendFile(path, `${JSON.stringify(round)}\n`, 'utf8');
    });
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
} {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return typeof record.at === 'string'
        && Array.isArray(record.blockingIds)
        && (record.revisionId === undefined || typeof record.revisionId === 'string')
        && (record.manifestHash === undefined || typeof record.manifestHash === 'string');
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
                // reported one more round than it had — and `navigation` feeds these rounds to `reviewProgress` whatever
                // the kind says, so the loop's escalation counted rounds nobody recorded. The parseable prefix stays, for
                // diagnosis; the count does not grow for a line that is not a round.
                malformedLine ??= lines.filter((candidate) => candidate.trim() !== '').indexOf(line) + 1;
                continue;
            }
            rounds.push({
                at: parsed.at,
                ...(typeof parsed.revisionId === 'string' ? { revisionId: parsed.revisionId } : {}),
                ...(typeof parsed.manifestHash === 'string' ? { manifestHash: parsed.manifestHash } : {}),
                blockingIds: parsed.blockingIds.filter((id): id is string => typeof id === 'string'),
                blockingCount: typeof parsed.blockingCount === 'number' ? parsed.blockingCount : null,
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
