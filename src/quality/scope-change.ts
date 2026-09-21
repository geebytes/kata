import { relative, resolve } from 'node:path';
import { scopeChangesPath, taskPath } from '../core/layout.js';
import { mutateTaskArtefact } from '../core/state.js';
import { readValidatedOptional } from '../core/schema.js';

/**
 * Recorded scope changes (§21.3), and why an unrecorded one is the expensive kind.
 *
 * The measurement: one task's audited surface grew **silently** — a script, then a carrier, then a mirror, then tests for
 * all three — and each addition did two expensive things at once: it expanded what the gate considered in scope, and it
 * invalidated the evidence, restarting the search. Nowhere in that growth was a decision point where the cost was visible.
 *
 * `ownedPaths` is what the seal hashes, what a revision's identity covers, and what the adversarial gate re-verifies. So
 * changing it is never a bookkeeping edit: **it is a change to what a round is about**. This module makes that a decision
 * with a reason and a base rather than a drift the rounds absorb.
 *
 * This is C1's missing half: batching controls how *often* a round happens, and this controls what a round is *about*.
 */
export interface ScopeChange {
    id: string;
    at: string;
    /** Who made the decision, so growth is attributable rather than ambient. */
    by: string;
    /** Why the surface had to grow — the sentence the next reader will judge it by. */
    reason: string;
    added: string[];
    removed: string[];
    /** The complete scope this change resulted in, so "what is the surface now" is recorded rather than reconstructed. */
    scope: string[];
    /** The revision before the change: the delta a re-verification measures against. */
    baseRevisionId?: string;
    baseManifestHash?: string;
    /** Ownership conflicts the addition was allowed to take on, so an approved conflict stays visible. */
    conflicts?: Array<{ taskId: string; path: string }>;
}

export interface ScopeChangeRecord {
    changes: ScopeChange[];
    updatedAt: string;
}

/** What a proposed change would do, before it is recorded. */
export interface ScopeChangePreview {
    added: string[];
    removed: string[];
    conflicts: Array<{ taskId: string; path: string }>;
    /** A change that adds nothing is refused, because an empty scope change is a decision with no content. */
    empty: boolean;
}

/**
 * The one rule for what a declared scope may contain, applied at the **write**.
 *
 * Both halves of this were found by an independent adversarial pass through the shipped CLI, and both are the class this
 * change exists to retire: a write path that trusts its input while every read path validates it.
 *
 * - At least one path. The task schema requires it, and `applyScopeChange` used to write `change.scope` verbatim, so a
 *   scope change that removed the last owned path produced `ownedPaths: []`. Every task-reading command then failed with a
 *   schema error — including `scope change --add`, the command that would have added one back — so the task was
 *   unrecoverable from the CLI, while `scope apply` reported success and changed nothing.
 * - Inside the repository. An absolute path or `../outside.ts` was accepted, stored, printed by `scope show` as
 *   `layer: deliverable`, and carried into the design handoff; `normalizeOwnedPaths` refused it only at seal.
 *
 * The normalization is the same one the revision hash uses (`./docs/note.md` and `docs/note.md` are one path), so the
 * stored surface is the surface a revision will hash — not the spelling the caller happened to use.
 */
export function normalizeScopePaths(root: string, paths: string[]): { paths: string[] } | { refused: string } {
    const normalized: string[] = [];
    for (const path of paths) {
        const dotted = relative(root, resolve(root, path)).replaceAll('\\', '/');
        if (!dotted || dotted === '..' || dotted.startsWith('../')) {
            return { refused: `A scope change must name at least one path inside the repository: ${path}` };
        }
        normalized.push(dotted);
    }
    const unique = [...new Set(normalized)].sort();
    if (unique.length === 0) {
        return { refused: 'A scope change must leave at least one owned path: the task schema requires one, and a task with none cannot be read by any command, including the one that would add it back.' };
    }
    return { paths: unique };
}

export async function previewScopeChange(
    root: string,
    taskId: string,
    current: string[],
    next: string[],
): Promise<ScopeChangePreview> {
    // Both sides are normalized first, so `src/` and `src` are one path rather than an addition plus a removal. A
    // spelling difference is not growth, and a change that changes nothing has to stay refusable (it is a decision with
    // no content).
    const normalize = (paths: string[]): string[] => [...new Set(paths.map((path) => relative(root, resolve(root, path)).replaceAll('\\', '/')))]
        .filter((path) => path && path !== '..' && !path.startsWith('../'));
    const before = new Set(normalize(current));
    const after = new Set(normalize(next));
    const added = [...after].filter((path) => !before.has(path)).sort();
    const removed = [...before].filter((path) => !after.has(path)).sort();
    const { findOwnershipConflicts } = await import('../workflow/revision.js');
    const conflicts = added.length > 0 ? await findOwnershipConflicts(root, taskId, added).catch(() => []) : [];
    return { added, removed, conflicts, empty: added.length === 0 && removed.length === 0 };
}

/**
 * Records a scope change.
 *
 * The base revision is **read here**, not supplied: it is the revision the change is measured against, and a caller who
 * passes the revision they are about to seal would make the following delta empty — the same mistake C1's batch base was
 * renamed to prevent.
 */
export async function recordScopeChange(
    root: string,
    taskId: string,
    input: { next: string[]; current: string[]; reason: string; by: string; allowConflicts?: boolean },
): Promise<ScopeChange | { refused: string }> {
    if (!input.reason?.trim()) {
        return { refused: 'A scope change requires --reason: growth that expands what a round is about is a decision, and an unexplained one is the drift this records.' };
    }
    // The paths are checked before anything else reads them, so `added`/`removed`/`conflicts` are computed over the
    // surface that will actually be stored.
    const normalizedNext = normalizeScopePaths(root, input.next);
    if ('refused' in normalizedNext) return { refused: normalizedNext.refused };
    const next = normalizedNext.paths;
    const preview = await previewScopeChange(root, taskId, input.current, next);
    if (preview.empty) {
        return { refused: 'The proposed scope is identical to the current one, so there is nothing to record.' };
    }
    if (preview.conflicts.length > 0 && !input.allowConflicts) {
        return {
            refused: `The added paths overlap another task's ownership (${preview.conflicts.map((conflict) => `${conflict.taskId}:${conflict.path}`).join(', ')}). `
                + 'Pass --allow-ownership-conflicts to take them on deliberately, which records the conflict with this change.',
        };
    }

    const { readCurrentTaskRevision } = await import('../workflow/revision.js');
    const base = await readCurrentTaskRevision(root, taskId).catch(() => null);

    let recorded: ScopeChange | null = null;
    await mutateTaskArtefact(root, taskId, scopeChangesPath(root, taskId), async () => {
        const record = await readScopeChanges(root, taskId);
        recorded = {
            id: `scope-${record.changes.length + 1}`,
            at: new Date().toISOString(),
            by: input.by,
            reason: input.reason,
            added: preview.added,
            removed: preview.removed,
            scope: next,
            ...(base ? { baseRevisionId: base.id, baseManifestHash: base.manifestHash } : {}),
            ...(preview.conflicts.length > 0 ? { conflicts: preview.conflicts } : {}),
        };
        return `${JSON.stringify({ changes: [...record.changes, recorded], updatedAt: new Date().toISOString() }, null, 2)}\n`;
    });
    return recorded as unknown as ScopeChange;
}

export async function readScopeChanges(root: string, taskId: string): Promise<ScopeChangeRecord> {
    return (await readValidatedOptional<ScopeChangeRecord>('scope-changes', scopeChangesPath(root, taskId))) ?? { changes: [], updatedAt: new Date(0).toISOString() };
}

/** The base the next re-verification should measure against: the last recorded scope change's revision. */
export async function lastScopeChangeBase(root: string, taskId: string): Promise<{ id: string } | null> {
    const change = (await readScopeChanges(root, taskId)).changes.at(-1);
    return change ? { id: change.baseRevisionId ?? change.id } : null;
}

/**
 * Whether the declared scope in the task record matches what the paths were last sized at.
 *
 * Reported rather than enforced: a task may legitimately narrow its scope, and the record is what a reader consults. What
 * this prevents is the silent case — growth that never went through the decision, so nothing anywhere says the surface
 * changed.
 */
export async function unreportedScopeGrowth(root: string, taskId: string, declared: string[]): Promise<string[]> {
    const changes = (await readScopeChanges(root, taskId)).changes;
    if (changes.length === 0) return [];
    // Compare against the scope the last recorded change resulted in — recorded, not reconstructed. A diff alone cannot
    // say what the scope was before the first change, and guessing it would make the check report the original scope as
    // growth.
    const recorded = new Set(changes.at(-1)?.scope ?? []);
    // The recorded surface is normalized by the write path, so the comparison normalizes the caller's spelling too:
    // `src/` and `src` are the same owned path, and reporting one as unreported growth would be a false positive.
    return declared
        .map((path) => relative(root, resolve(root, path)).replaceAll('\\', '/'))
        .filter((path) => path && !recorded.has(path))
        .sort();
}

/** What applying a recorded scope change did, or why it could not. */
export interface ScopeApplyResult {
    applied: boolean;
    /** The owned paths after the change, when it applied. */
    ownedPaths?: string[];
    reason?: string;
}

/**
 * Applies a recorded scope change to the task's `ownedPaths`.
 *
 * Recording was the whole mechanism, and it was half of one: `recordScopeChange` writes the decision into
 * `scope-changes.json`, while `ownedPaths` is what a revision hashes, what a delta is computed over and what the
 * adversarial gate re-verifies. So the six scope changes one measured task recorded changed the audited surface by
 * nothing at all — every revision carried the same owned-path digest (`4522af1eaa…`) — and the CLI's own output pointed
 * at `kata-cli scope apply`, a subcommand that did not exist. This is that subcommand's engine: the recorded decision is
 * applied, or it is refused and said so.
 *
 * The change is written through `mutateTaskArtefact` so it lands under the task lock like every other task mutation, and
 * the read-modify-write is inside that lock rather than around it.
 */
export async function applyScopeChange(root: string, taskId: string, changeId?: string): Promise<ScopeApplyResult> {
    const record = await readScopeChanges(root, taskId);
    const change = changeId
        ? record.changes.find((candidate) => candidate.id === changeId)
        : record.changes.at(-1);
    if (!change) {
        return {
            applied: false,
            reason: changeId
                ? `No recorded scope change '${changeId}' exists for task '${taskId}'; record it with \`kata-cli scope change\` before applying it.`
                : `No recorded scope change exists for task '${taskId}'; there is nothing to apply.`
        };
    }

    // Validated here as well as at the record, deliberately. The rule belongs on the write that changes the task, so it
    // has to hold for a record that reached `scope-changes.json` by any route — a hand-edit, or a record written before
    // the rule existed. A guard only on the record path would leave this one reachable.
    const normalized = normalizeScopePaths(root, change.scope);
    if ('refused' in normalized) return { applied: false, reason: normalized.refused };

    let ownedPaths: string[] = [];
    await mutateTaskArtefact(root, taskId, taskPath(root, taskId), async (raw) => {
        const task = JSON.parse(raw) as { ownedPaths?: string[] };
        // The recorded `scope` is the complete resulting surface, so applying is a set, not a merge. Merging would let a
        // removal (a deliberate narrowing) be silently undone by the union.
        ownedPaths = normalized.paths;
        const next = { ...task, ownedPaths };
        return `${JSON.stringify(next, null, 2)}\n`;
    });
    return { applied: true, ownedPaths };
}
