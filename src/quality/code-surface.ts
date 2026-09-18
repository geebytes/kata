import { hashContent } from '../core/hash.js';
import type { TaskRevision } from '../workflow/revision.js';

/**
 * Which parts of a task's owned set are **code** (C2 of the pass-cost proposal), and the sub-manifest over them.
 *
 * The measurement: **three cycles in one day were pure governance-text edits** — one acceptance statement, three rewrites
 * — and each cost about an hour of re-verification for roughly twenty words. Every revision invalidated both nodes'
 * passes, including the pass that had verified the code and had nothing to say about the sentence.
 *
 * What this classifies is deliberately narrow and conservative: a path is **non-code** only when it is a documentation or
 * governance artefact *by extension or by well-known directory*, and everything else — including anything unrecognised —
 * is code. An unrecognised path that is really prose costs one unnecessary re-verification; the opposite error would let
 * a code change leave a code verdict standing, which is the failure mode §15 forbids.
 */
const NON_CODE_EXTENSIONS = [
    '.md',
    '.mdx',
    '.txt',
    '.rst',
    '.adoc',
    '.jsonc',
] as const;

/** Directories whose contents are governance or documentation by convention. */
const NON_CODE_DIRECTORIES = ['docs/', 'wiki/', '.llmwiki/'] as const;

/**
 * Whether an owned path is non-code.
 *
 * `AGENTS.md`, `docs/**` and the wiki are the shapes the measurement was about; a `.json` config is **not** treated as
 * non-code even when it holds prose, because a configuration file can change a gate's behaviour and this classification
 * exists to preserve verdicts, not to save time at the risk of one.
 */
export function isNonCodePath(path: string): boolean {
    const normalized = path.replace(/^\.\//, '');
    if (NON_CODE_DIRECTORIES.some((directory) => normalized.startsWith(directory))) return true;
    return NON_CODE_EXTENSIONS.some((extension) => normalized.endsWith(extension));
}

/** The owned paths that are code, and the ones that are not. */
export function splitOwnedPaths(ownedPaths: string[]): { code: string[]; nonCode: string[] } {
    const code: string[] = [];
    const nonCode: string[] = [];
    for (const path of ownedPaths) (isNonCodePath(path) ? nonCode : code).push(path);
    return { code, nonCode };
}

/**
 * The content identity of a revision's **code** paths, or `null` when it cannot be derived.
 *
 * `null` is the honest answer, not a fallback: a revision sealed before per-path digests existed cannot say which of its
 * paths are code, and a caller that needs the sub-manifest must then treat the code as unverified rather than assume it is
 * unchanged. Every consumer of this is required to fall back to full invalidation when it gets `null`.
 */
export function codeManifestHash(revision: Pick<TaskRevision, 'ownedPaths' | 'pathDigests'>): string | null {
    if (!revision.pathDigests) return null;
    const { code } = splitOwnedPaths(revision.ownedPaths);
    if (code.length === 0) return null;
    // Deterministic over the sorted paths, so the same content always gives the same identity.
    const payload = code
        .map((path) => `${path}\u0000${revision.pathDigests?.[path] ?? ''}`)
        .sort()
        .join('\u0001');
    return hashContent(payload);
}

/**
 * Whether a change between two revisions touched **code**.
 *
 * Answers the question a verdict needs before it may stand: a claims pass may survive a governance-text edit, and a code
 * pass may not. When either side cannot be classified — no digests, or no code paths at all — the answer is `true`, so the
 * caller falls back to full invalidation and says so (the proposal's C2 invariant).
 */
export function touchMovedCode(
    before: Pick<TaskRevision, 'ownedPaths' | 'pathDigests'> | null,
    after: Pick<TaskRevision, 'ownedPaths' | 'pathDigests'>,
): boolean {
    if (!before) return true;
    const beforeHash = codeManifestHash(before);
    const afterHash = codeManifestHash(after);
    if (beforeHash === null || afterHash === null) return true;
    return beforeHash !== afterHash;
}

/** Whether the only difference is in non-code paths — the case whose re-verification the measurement said is wasted. */
export function textOnlyChange(
    before: Pick<TaskRevision, 'ownedPaths' | 'pathDigests'> | null,
    after: Pick<TaskRevision, 'ownedPaths' | 'pathDigests'>,
): boolean {
    return !touchMovedCode(before, after);
}
