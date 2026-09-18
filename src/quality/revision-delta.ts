import { computePathDigests, type TaskRevision } from '../workflow/revision.js';

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

/** The same comparison against what is on disk right now, taken over the base revision's owned set. */
export async function changeSurfaceAgainstWorkspace(root: string, base: TaskRevision): Promise<DeltaStatus> {
    if (!base.pathDigests) {
        return { status: 'delta_unavailable', reason: `revision ${base.id} was sealed before per-path digests were recorded` };
    }
    const currentDigests = await computePathDigests(root, base.ownedPaths);
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
