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
/**
 * The test that decides whether a history record is the replaced copy of the live one rather than a round of its own.
 *
 * Exported because two modules report a change's rounds — `reportRounds` and `roundCost` — and they produced different counts once
 * before by restating this (`kgsr8-f2`). A key over one record cannot express containment, so the test is a function of the pair.
 */
export function replacedCopyFilter(
    live: Record<string, unknown> | null,
    /** The node's history, which lives in its own file rather than on the live record — the caller reads it, and this needs it. */
    history: ReadonlyArray<Record<string, unknown>> = [],
): (record: Record<string, unknown>) => boolean {
    // **The chain, walked by the relation `writeAdversarialRecord` records** (`rba-r14-f1`, `rba-r15-f1`, `rba-r15-f2`, `rba-r16-f1`,
    // `rba-r16-f2`). Four versions of this test have now been wrong, and the failure of each is worth keeping:
    //
    //   1. asking the records' own fields — a replacement inherits the revision (a re-stamp) *or* keeps it while findings accumulate, so
    //      no field pair separates the shapes;
    //   2. recording the pair `(createdAt, finding count)` — but a round that confirms findings through the CLI the brief instructs
    //      reviewers to use (`adversarial finding add`, once per finding) grows the count between the write of the relation and the read;
    //   3. walking `live.history` — **a field no producer writes**, because the history is its own file, so the walk was one step while
    //      its comment described a chain.
    //
    // What decides it: the live record names the `createdAt` of the record it replaced, the history is read by the caller and passed in,
    // and an entry that is itself a replacement names what *it* replaced. The walk follows that as far as the records carry it.
    if (!live) return () => true;
    // **A round is identified by the events that produced it, not by reading the timestamps back** (`rba-r18-f1`, `rba-r18-f2` — two
    // independent passes, and the sixth version of this test). The history is a stack of snapshots, and the snapshots of one round are
    // exactly the records an `append` write produced:
    //
    //   * `replacedBy === 'append'` → the write added findings to the record already in the slot, so the record it names is an **older
    //     snapshot of the same round** and is dropped;
    //   * `replacedBy === 'round'` → a fresh pass replaced a different round, and that round **stays counted**.
    //
    // The retired version inferred the shape from `createdAt === replacedCreatedAt`, and that inference is unsound in both directions,
    // measured: an append *overwrites* the live record's link with a link to itself, so a fresh pass over an appended round walked an empty
    // chain and dropped nothing — `closure-gate` reported 7 rounds against 10 records — while the same rule in the other direction left
    // **both** snapshots of an appended round in the count, so a change that ran two rounds reported three. Both numbers were plausible,
    // which is why both survived a reading.
    const idsOf = (record: Record<string, unknown>): string =>
        (Array.isArray(record.findings)
            ? (record.findings as Array<{ id?: unknown }>).map((finding) => String(finding?.id ?? ''))
            : []).sort().join(',');
    const contentOf = (record: Record<string, unknown>): string => `${String(record.createdAt ?? '')}|${idsOf(record)}`;
    const predecessorOf = (record: Record<string, unknown>): string | null =>
        record.replacedBy === 'append' && typeof record.replacedCreatedAt === 'string'
            ? `${record.replacedCreatedAt}|${(Array.isArray(record.replacedFindingIds) ? (record.replacedFindingIds as unknown[]).map((id) => String(id)) : []).sort().join(',')}`
            : null;

    const byContent = new Map<string, Record<string, unknown>>();
    for (const record of history) byContent.set(contentOf(record), record);
    const dropped = new Set<string>();
    // Every record that some other record names as its append predecessor is a snapshot of that other record's round.
    const links: Array<Record<string, unknown> | null> = [...history, live];
    for (const record of links) {
        if (!record) continue;
        const predecessor = predecessorOf(record);
        if (predecessor) dropped.add(predecessor);
    }
    // And the chain is followed, so a round appended to three times keeps only its newest snapshot.
    let cursor: Record<string, unknown> | null = live;
    for (let steps = 0; cursor && steps < 64; steps += 1) {
        const predecessor = predecessorOf(cursor);
        if (!predecessor) break;
        dropped.add(predecessor);
        cursor = byContent.get(predecessor) ?? null;
    }
    return (record) => !dropped.has(contentOf(record));
}



export async function reportRounds(root: string, taskId: string, node = 'review'): Promise<RoundReport> {
    const history = await readJson<Array<Record<string, unknown>>>(join(kataDir(root), 'tasks', taskId, `adversarial-${node}-history.json`)) ?? [];
    const live = await readJson<Record<string, unknown>>(join(kataDir(root), 'tasks', taskId, `adversarial-${node}.json`));

    const toRound = (record: Record<string, unknown>): ReviewRound => ({
        revisionId: String(record.revisionId ?? '(none)'),
        findings: Array.isArray(record.findings) ? record.findings.length : 0,
        recordedAt: String(record.createdAt ?? ''),
    });
    // **Identity went through four versions, and the fourth is the one the data supports.** (1) `revisionId` alone collapsed two rounds
    // that ran on one revision. (2) `revisionId@createdAt` is not unique either, because a record is written with the timestamp of the
    // pass it *replaces*. (3) Comparing whole records counted the same round twice once a finding was appended to the live copy —
    // measured: `becb49c9303042ca` appeared in the history and as the live record with different findings, four entries for three
    // rounds. (4) So the test is not equality at all: **a history record whose revision matches the live record's and whose findings the
    // live record also holds is the copy that was replaced**, which is a containment test rather than a key (`rba-r3-f1`). Where the
    // revisions differ the record is a round of its own — that is the re-stamp `rba4-f1` measured.
    //
    // **There is no key for a round** — `recordIdentity` was deleted rather than kept "for a consumer that needs a stable key", because
    // no such consumer exists (`rba-r14-f2`: it was matched only by its own definition and by the comment claiming a consumer).
    const historyRounds = history.filter(replacedCopyFilter(live as unknown as Record<string, unknown> | null, history)).map(toRound);
    // **And the order is not a clock reading.** `recordedAt` is inherited from the replaced pass, so sorting by it put the live record
    // before a history record that was actually earlier — measured: `[daf33fef@13:45, becb49c9@13:45, 48f7fb8e@01:10]`. The live record
    // is the latest by construction, because it is what the previous pass was replaced with.
    const rounds = live ? [...historyRounds, toRound(live as unknown as Record<string, unknown>)] : historyRounds;

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
            // **No population, no share** (`rba-r3-f5`): `Math.max(1, …)` manufactured a denominator, so a latest round with no
            // hypothesis targets reported a *measured* convergence over a population of one that does not exist. `null` is the honest
            // value for a question the record cannot answer — the same distinction this line settled for `share` when a change surface
            // could not be derived.
            : (allTargets(live) > 0 ? aboutThePreviousRound / allTargets(live) : null),
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
