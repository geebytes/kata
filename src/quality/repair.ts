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
export type RepairReason = 'review_findings' | 'revision_superseded' | 'judge_fail' | 'verify_fail' | 'verify_reseal';

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
    /** Every round recorded, measured or not. */
    rounds: number;
    /** The trailing run of rounds that did not reduce the count. */
    noProgressRounds: number;
    escalating: boolean;
    /** What the newest measured round was opened for. Empty when no round measured anything. */
    blockingIds: string[];
    /** Rounds that recorded no count, reported rather than dropped: an unmeasured round is not an improvement. */
    unmeasuredRounds: number;
}

export function reviewRoundsPath(root: string, taskId: string): string {
    return join(taskDir(root, taskId), 'review-rounds.jsonl');
}

/**
 * Derive the loop's progress from the recorded rounds.
 *
 * Only rounds that measured a count participate in the comparison, and a run of them is what escalates: a round that
 * measured nothing can neither be progress nor be read as one.
 */
export function reviewProgress(rounds: readonly ReviewRound[]): ReviewProgress {
    // **Progress is measured against the best count reached so far, not against the round before it.** An oscillating
    // loop (5 → 4 → 5 → 4 → …) reads as progress at every single step under the neighbouring comparison, and it is
    // plainly stuck: it has not reached a new low since round 2. A loop that only ever gets worse is the same fact with
    // the sign flipped, and both must escalate.
    let best: number | null = null;
    let noProgressRounds = 0;
    let unmeasuredRounds = 0;
    let newestMeasuredIds: string[] = [];
    for (const round of rounds) {
        if (round.blockingCount === null) {
            // **Neutral, and counted.** A round that measured nothing is neither progress nor a failure to progress, so it
            // neither resets the run nor extends it; `unmeasuredRounds` reports it, because a history that could not be
            // measured at all must not read as a healthy loop.
            unmeasuredRounds += 1;
            continue;
        }
        newestMeasuredIds = [...round.blockingIds];
        if (best === null || round.blockingCount < best) {
            best = round.blockingCount;
            noProgressRounds = 0;
        } else {
            noProgressRounds += 1;
        }
    }
    return {
        rounds: rounds.length,
        noProgressRounds,
        escalating: noProgressRounds >= NO_PROGRESS_ROUNDS,
        blockingIds: newestMeasuredIds,
        unmeasuredRounds,
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

/**
 * Read the recorded rounds, oldest first.
 *
 * A line that cannot be parsed becomes an **unmeasured round** rather than being dropped. Both readings leave
 * `reviewProgress`'s trailing run identical — an unmeasured round is neutral there — so the difference is what the
 * history *says about itself*: `rounds` and `unmeasuredRounds` count a damaged line, and a dropped one would leave the
 * file looking shorter than it is. An absent file is an empty history — a change under its first repair has no rounds
 * yet — and that is the only case that reads as nothing was ever recorded.
 */
export async function readReviewRounds(root: string, taskId: string): Promise<ReviewRound[]> {
    let raw: string;
    try {
        raw = await readFile(reviewRoundsPath(root, taskId), 'utf8');
    } catch {
        return [];
    }
    const rounds: ReviewRound[] = [];
    for (const line of raw.split('\n')) {
        if (line.trim() === '') continue;
        try {
            const parsed = JSON.parse(line) as Partial<ReviewRound>;
            rounds.push({
                at: typeof parsed.at === 'string' ? parsed.at : '',
                blockingIds: Array.isArray(parsed.blockingIds) ? parsed.blockingIds.filter((id): id is string => typeof id === 'string') : [],
                blockingCount: typeof parsed.blockingCount === 'number' ? parsed.blockingCount : null,
            });
        } catch {
            rounds.push({ at: '', blockingIds: [], blockingCount: null });
        }
    }
    return rounds;
}
