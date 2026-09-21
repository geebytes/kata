import { computePathDigests, type TaskRevision } from '../workflow/revision.js';
import { changedGitPaths } from '../core/git.js';

/**
 * What changed between two revisions of the same task, by content (F2 of the finding-lifecycle design).
 *
 * The design's problem: re-verification cost was independent of the size of the change. Records bind to a whole owned
 * manifest, so a two-line repair paid for a full independent pass — measured at 619s–1331s per round, and five of eleven
 * rounds were spent on defects the previous round's repair had introduced or left uncovered.
 *
 * The answer is not to trust a smaller claim: it is to make the smaller claim **checkable**. `TaskRevision.pathDigests`
 * records what each owned file hashed to at seal time, so a pass can say "I reviewed everything, but I only re-derived
 * the conclusions that touch these paths", and the gate can verify mechanically that the path set it was given really
 * covers every difference between the two revisions. A delta that does not cover the difference is refused
 * (`delta_stale`), and a revision with no digests at all yields `delta_unavailable` rather than a guessed diff.
 */

export type DeltaStatus =
    | { status: 'available'; changedPaths: string[]; added: string[]; modified: string[]; removed: string[] }
    | { status: 'unchanged' }
    | { status: 'delta_unavailable'; reason: string };

export interface DeltaComparison {
    base: TaskRevision;
    current: TaskRevision;
}

/** The changed / added / removed paths between two per-path tables, in a deterministic order. */
export function diffPathDigests(
    base: Record<string, string>,
    current: Record<string, string>,
): { added: string[]; modified: string[]; removed: string[]; changedPaths: string[] } {
    const added: string[] = [];
    const modified: string[] = [];
    const used = new Set<string>();

    for (const [path, digest] of Object.entries(current).sort(([a], [b]) => a.localeCompare(b))) {
        used.add(path);
        if (!(path in base)) added.push(path);
        else if (base[path] !== digest) modified.push(path);
    }
    const removed = Object.keys(base).filter((path) => !used.has(path)).sort();
    return { added, modified, removed, changedPaths: [...added, ...modified, ...removed] };
}

/**
 * The change surface between a base revision and the current one.
 *
 * `recomputed` compares against the **current content on disk** rather than against another revision's table, which is
 * what a re-seal needs: the base is a recorded revision, the current content is what a pass would actually review.
 */
export async function changeSurface(
    root: string,
    base: TaskRevision,
    current: TaskRevision | Record<string, string>,
): Promise<DeltaStatus> {
    if (!base.pathDigests) {
        return {
            status: 'delta_unavailable',
            reason: `revision ${base.id} was sealed before per-path digests were recorded`,
        };
    }
    const currentDigests = Object.prototype.hasOwnProperty.call(current, 'pathDigests')
        ? (current as TaskRevision).pathDigests
        : (current as Record<string, string>);
    if (!currentDigests) {
        return { status: 'delta_unavailable', reason: 'the current revision records no per-path digests' };
    }

    const diff = diffPathDigests(base.pathDigests, currentDigests);
    if (diff.changedPaths.length === 0) return { status: 'unchanged' };
    return { status: 'available', ...diff };
}

/**
 * The same comparison against what is on disk right now, over the base revision's owned set **plus** every path the
 * working tree reports as changed.
 *
 * The second half is the correction. Measuring only `base.ownedPaths` answers "did the declared surface move", which is
 * a different question from "did this round change anything" — and the difference is what a round that edited docs,
 * tests or tooling outside its declaration exploited: the surface said `unchanged`, so the next pass was told there was
 * nothing to re-derive. The fact is available and cheap (`git status`), the base revision's digests are already known,
 * and a path the base never hashed has every reason to count as added rather than to be invisible.
 */
export async function changeSurfaceAgainstWorkspace(
    root: string,
    base: TaskRevision,
    current?: TaskRevision | null,
): Promise<DeltaStatus> {
    if (!base.pathDigests) {
        return { status: 'delta_unavailable', reason: `revision ${base.id} was sealed before per-path digests were recorded` };
    }
    // Three sources, unioned and sorted so the digest tables line up:
    //
    //  - the base's own paths, which it has digests for;
    //  - every path git reports as changed, which may be outside the declaration entirely;
    //  - **the current revision's recorded paths**, which is the correction an independent pass measured on the real
    //    task: a file added by a round that committed before sealing appears in neither of the first two — it is absent
    //    from the base's digest table, and `git status` is clean once it is committed — so the brief's `Added:` list was
    //    empty while the gate's own comparison named three added paths. The revision's digest table is the only source
    //    that still knows what the round added.
    const paths = [...new Set([
        ...base.ownedPaths,
        ...changedGitPaths(root),
        ...Object.keys(current?.pathDigests ?? {}),
    ])].sort();
    // The walk re-derives digests for the base's owned shape; the current revision's own recorded digests are the
    // authority for the paths it knows about, because it hashed them itself (including files that no longer exist as
    // directory members). Recomputing those would make a committed-then-deleted path read as absent rather than removed.
    const walked = await computePathDigests(root, paths);
    // `walked` is the comparison for every path in the union. The current revision's recorded digest is consulted only
    // where the walk produced nothing — a path it hashed that no longer exists on disk (removed, or produced by a build
    // artefact), which must read as removed rather than as never-having-existed. It is deliberately **not** a third
    // source of *added* paths: a guide that invented paths from a digest table would report entries the revision never
    // claimed. Visibility comes from the union alone.
    const currentDigests: Record<string, string> = { ...walked };
    // The recorded digest is substituted **only for a path the current revision knows and the base did not** — the added
    // set, which is why the union admits those keys at all. Two narrower-looking rules are both wrong, and each was
    // caught by a test rather than by reading:
    //
    //  - substituting for every path the base knew re-introduces the base's own value and reports `unchanged` when the
    //    file changed on disk (measured: a repair-batch case went from `changedPaths: ['src/a.py']` to `[]`);
    //  - substituting whenever the current revision is present is the same defect one step over, because the current
    //    revision often *is* the base — `createTaskRevision` makes it current, so a single-revision workspace has
    //    `current.id === base.id` and the substitution would compare the base against itself.
    if (current && current.id !== base.id) {
        for (const [path, digest] of Object.entries(current.pathDigests ?? {})) {
            if (!(path in base.pathDigests)) currentDigests[path] = digest;
        }
    }
    const diff = diffPathDigests(base.pathDigests, currentDigests);
    if (diff.changedPaths.length === 0) return { status: 'unchanged' };
    return { status: 'available', ...diff };
}

/**
 * Whether a delta pass's declared path set really covers the change it claims to cover.
 *
 * The whole safety of a delta rests here, and it is deliberately mechanical: every path the comparison calls changed must
 * appear in the pass's `changedPaths`. Anything less is `delta_stale` — the gate's way of saying "your smaller claim is
 * not true of this content", which is a refusal, never a silent narrowing.
 */
export function deltaCoversChange(
    declared: string[],
    change: Extract<DeltaStatus, { status: 'available' }>,
): { covered: boolean; missing: string[] } {
    const declaredSet = new Set(declared);
    const missing = change.changedPaths.filter((path) => !declaredSet.has(path));
    return { covered: missing.length === 0, missing };
}
