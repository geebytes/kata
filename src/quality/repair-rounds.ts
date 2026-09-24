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
    targetsAboutThePreviousRound: number;
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

export async function reportRounds(root: string, taskId: string, node = 'review'): Promise<RoundReport> {
    const history = await readJson<Array<Record<string, unknown>>>(join(kataDir(root), 'tasks', taskId, `adversarial-${node}-history.json`)) ?? [];
    const live = await readJson<Record<string, unknown>>(join(kataDir(root), 'tasks', taskId, `adversarial-${node}.json`));

    const toRound = (record: Record<string, unknown>): ReviewRound => ({
        revisionId: String(record.revisionId ?? '(none)'),
        findings: Array.isArray(record.findings) ? record.findings.length : 0,
        recordedAt: String(record.createdAt ?? ''),
    });
    const rounds = history.map(toRound);
    // **A round is a record, not a revision.** The first version deduped the live record by `revisionId`, and two rounds can
    // run on the same revision — round 4 and round 5 of the change this was written from did — so it reported three rounds
    // where four left records. Identity is the record: its revision and when it was made.
    const key = (round: ReviewRound) => `${round.revisionId}@${round.recordedAt}`;
    if (live && !rounds.some((round) => key(round) === key(toRound(live)))) rounds.push(toRound(live));

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
        shareAboutThePreviousRound: live
            ? aboutThePreviousRound / Math.max(1, allTargets(live))
            : null,
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
): Promise<number> {
    if (rounds.length < 2 || !live) return 0;
    const previous = rounds.at(-2);
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
    if (!base) return 0;
    const delta = revisionChangeSurface(base, current);
    const changed = new Set(delta.status === 'available' ? delta.changedPaths : []);
    if (changed.size === 0) return 0;

    const hypotheses = Array.isArray(live.hypotheses) ? (live.hypotheses as Array<{ targets?: string[] }>) : [];
    const targeted = new Set(hypotheses.flatMap((hypothesis) => hypothesis.targets ?? []));
    return [...targeted].filter((target) => changed.has(target)).length;
}
