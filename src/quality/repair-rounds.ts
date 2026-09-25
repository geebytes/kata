/**
 * How many review rounds a change has had, and how many of the latest round's findings are about what the previous round
 * changed — the two numbers that say whether a change is converging.
 *
 * `repair-by-another-author` AC-3, and it is the criterion that cannot be argued with: it counts rather than judges. The five
 * rounds of `closure-gate` were reconstructed by hand from a directory listing to reach the conclusion that the change could not
 * be finished by its author; this makes that reconstruction a command.
 *
 * **A round is a record, not an attempt.** A round that produced nothing leaves no trace here — which is honest (there is
 * nothing to report) and is also the reason the count can be lower than the number of rounds actually run. `closure-gate` had
 * five attempts and four records, and `unrecorded` is reported for exactly that reason rather than being papered over.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { kataDir } from '../core/layout.js';

export type ReviewRound = {
    revisionId: string;
    findings: number;
    recordedAt: string;
};

export type RoundReport = {
    node: string;
    /** One entry per round that left a record, oldest first. */
    rounds: ReviewRound[];
    /**
     * **Targets** in the latest round that name a path the previous round changed — not findings, because a finding does not
     * carry targets and a hypothesis does. The first version divided this by the finding count, which mixed two units and
     * reported a share of 14 on real data.
     */
    /** Null when the change surface could not be derived — not zero, which would be a measured answer. */
    targetsAboutThePreviousRound: number | null;
    /** The share of the latest round's targets that are about the previous round's changes. */
    shareAboutThePreviousRound: number | null;
    /** True when the rounds do not account for every brief issued — a round that produced nothing. */
    unrecorded: boolean;
};

async function readJson<T>(path: string): Promise<T | null> {
    try {
        return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch {
        return null;
    }
}

/**
 * **One definition of "a round", for every module that reports one** (`kgsr8-f2`).
 *
 * A revision that appears both in a node's history and in its live slot is **one round** — the history holds the copy that was
 * replaced — and the two rounds that genuinely shared a revision differed in their hypotheses and attempts. So a round's identity is
 * its revision **plus the content of those two fields**. `roundCost` restated this as a fingerprint over their *lengths*, which is a
 * second derivation: it agrees today and would disagree the moment two rounds had equal counts and different content, which is
 * ordinary. Exported so no consumer can restate it.
 */
export function recordIdentity(record: Record<string, unknown>): string {
    const revision = String(record.revisionId ?? '(none)');
    const hypotheses = Array.isArray(record.hypotheses) ? JSON.stringify(record.hypotheses) : '';
    const attempts = Array.isArray(record.attempts) ? JSON.stringify(record.attempts) : '';
    return `${revision}#${hypotheses}#${attempts}`;
}

export async function reportRounds(root: string, taskId: string, node = 'review'): Promise<RoundReport> {
    const history = await readJson<Array<Record<string, unknown>>>(join(kataDir(root), 'tasks', taskId, `adversarial-${node}-history.json`)) ?? [];
    const live = await readJson<Record<string, unknown>>(join(kataDir(root), 'tasks', taskId, `adversarial-${node}.json`));

    const toRound = (record: Record<string, unknown>): ReviewRound => ({
        revisionId: String(record.revisionId ?? '(none)'),
        findings: Array.isArray(record.findings) ? record.findings.length : 0,
        recordedAt: String(record.createdAt ?? ''),
    });
    const rounds = history.map(toRound);
    // **Identity went through three versions, and each failed differently.** (1) `revisionId` alone collapsed two rounds that ran
    // on one revision. (2) `revisionId@createdAt` is not unique either, because a record is written with the timestamp of the
    // pass it *replaces*. (3) Comparing whole records then counted **the same round twice** once a finding was appended to the
    // live copy — measured on this task: `becb49c9303042ca` appeared in the history and as the live record with different
    // `findings`, so four entries for three rounds.
    //
    // A revision that appears both in the history and live is **one round**: the history holds the copy that was replaced, and
    // the two rounds that really shared a revision differed in more than their revision id — which is what the record's own
    // `attempts` and `hypotheses` describe, and what a fingerprint over those two fields captures without depending on a
    // value the writer inherits.
    // see `recordIdentity` below — the single definition, exported so `round-cost.ts` cannot restate it (`kgsr8-f2`).
    const seen = new Set(history.map(recordIdentity));
    if (live && !seen.has(recordIdentity(live))) rounds.push(toRound(live));
    // **And the order is not a clock reading.** `recordedAt` is inherited from the replaced pass (see `writeAdversarialRecord`),
    // so sorting by it put the live record **before** a history record that was actually earlier — measured:
    // `[daf33fef@13:45, becb49c9@13:45, 48f7fb8e@01:10]`, where the live record is the middle one. The live record is the
    // latest by construction, because it is the one the previous pass was replaced with; so it is moved to the end and the
    // history keeps its own order. That removes the need to believe a timestamp the writer copies.
    const historyRounds = history.map(toRound);
    const liveRound = live ? toRound(live) : null;
    const pushedLive = liveRound !== null && !seen.has(recordIdentity(live as Record<string, unknown>));
    const ordered = pushedLive ? [...historyRounds, liveRound] : historyRounds;
    rounds.length = 0;
    rounds.push(...ordered);

    // A round that left no record is invisible here, so the briefs are what say whether every attempt is accounted for.
    // **A round is a brief issued, and a record is a round that left something behind.** The first version asked whether the
    // latest brief file existed and whether there were no rounds at all — which is false the moment a round exists, so the
    // field was never true and its docstring described something the code could not report. Measured on `closure-gate`: five
    // briefs across four files, four records, and `unrecorded` false.
    const briefsDir = join(kataDir(root), 'tasks', taskId, 'adversarial-briefs');
    const briefFiles = await readdir(briefsDir).catch(() => [] as string[]);
    let issued = 0;
    for (const file of briefFiles.filter((name) => name.startsWith(`${node}-`) && name.endsWith('.json'))) {
        const entry = await readJson<{ briefs?: unknown[] }>(join(briefsDir, file));
        issued += entry?.briefs?.length ?? 0;
    }
    const unrecorded = issued > rounds.length;

    const aboutThePreviousRound = await countAboutThePreviousRound(root, taskId, node, rounds, live);
    return {
        node,
        rounds,
        targetsAboutThePreviousRound: aboutThePreviousRound,
        // Both null together, because a share needs a numerator: reporting a share over an unavailable count is the defect.
        shareAboutThePreviousRound: aboutThePreviousRound === null || !live
            ? null
            : aboutThePreviousRound / Math.max(1, allTargets(live)),
        unrecorded,
    };
}

/**
 * A finding is "about the previous round's repairs" when something it targeted is a path the previous round changed. The
 * targets are the round's own statement of what it examined, so this asks the record rather than guessing from prose.
 */
function allTargets(live: Record<string, unknown>): number {
    const hypotheses = Array.isArray(live.hypotheses) ? (live.hypotheses as Array<{ targets?: string[] }>) : [];
    return new Set(hypotheses.flatMap((hypothesis) => hypothesis.targets ?? [])).size;
}

async function countAboutThePreviousRound(
    root: string,
    taskId: string,
    node: string,
    rounds: ReviewRound[],
    live: Record<string, unknown> | null,
): Promise<number | null> {
    if (rounds.length < 2 || !live) return null;
    // **The round before the live one, by construction rather than by sort position** (rba5-f5): the list ends with the live
    // record when it was appended, so `at(-2)` is its predecessor. Reading `at(-2)` off a timestamp ordering put the live
    // record itself there and the share came out `null` for a change that had both a previous and a latest round.
    const liveAt = String(live.revisionId ?? '');
    const previous = rounds.at(-2)?.revisionId === liveAt ? rounds.at(-3) : rounds.at(-2);
    // **The change surface, not the owned-path manifest** (f1). The first version read the previous revision's
    // `pathDigests` keys and called them "the paths the previous round changed" — but that map is the revision's **owned**
    // paths, so the share was over ownership rather than over what changed, wrong in both directions: a declared path that did
    // not change counted, and a changed path outside the declaration did not. `revisionChangeSurface` exists for this and is
    // what the gate uses.
    //
    // The first attempt failed because the fixture wrote only `pathDigests`, while a revision carries both that and
    // `contentDigests` — and the surface derives from the latter. The fixture is fixed with it.
    const { readTaskRevision } = await import('../workflow/revision.js');
    const { revisionChangeSurface } = await import('./revision-delta.js');
    const base = await readTaskRevision(root, taskId, previous?.revisionId ?? '').catch(() => null);
    const current = await readTaskRevision(root, taskId, String(live.revisionId ?? '')).catch(() => null);
    if (!base) return null;
    const delta = revisionChangeSurface(base, current);
    // **`null` when the derivation could not answer, and `0` only when it did and the answer is none** (rba-f10). The
    // first version returned 0 for both, so a share of 0.000 was reported for a question the tool had no way to answer — the
    // same defect as a measured zero standing in for an unmeasured one, which this line has recorded twice already.
    if (delta.status !== 'available') return null;
    // **No empty-surface branch here** (rba4-f5): a surface with no changed paths reports `unchanged`, and the status check
    // above already returned `null` for anything that is not `available` — so the branch could never be taken, and unreachable
    // code reads like a case that is handled. An available delta has at least one path.
    const changed = new Set(delta.changedPaths);

    const hypotheses = Array.isArray(live.hypotheses) ? (live.hypotheses as Array<{ targets?: string[] }>) : [];
    const targeted = new Set(hypotheses.flatMap((hypothesis) => hypothesis.targets ?? []));
    return [...targeted].filter((target) => changed.has(target)).length;
}
