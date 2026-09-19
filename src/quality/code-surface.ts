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

/**
 * The owned paths, split three ways: **instrument**, **code**, and **governance text**.
 *
 * Two outputs were one short (design §24.4): a script under an owned path was "code", so an *instrument's* edits
 * invalidated a pass about the *deliverable* — the structural cause of four wasted rounds in one day. A declared
 * instrument is subtracted first, so its edits invalidate the instrument surface only.
 *
 * The instrument class is checked **before** the code/governance split on purpose: an instrument written in Markdown is
 * still an instrument, and the declaration is the more specific statement of what the path is for.
 */
export function splitOwnedPaths(ownedPaths: string[], task: { instruments?: string[] } = {}): { instruments: string[]; code: string[]; nonCode: string[] } {
    const instruments: string[] = [];
    const code: string[] = [];
    const nonCode: string[] = [];
    for (const path of ownedPaths) {
        if (isInstrumentPath(task, path)) instruments.push(path);
        else if (isNonCodePath(path)) nonCode.push(path);
        else code.push(path);
    }
    return { instruments, code, nonCode };
}

/**
 * The owned paths that are **instruments** (§21.1), or the empty array when the task declares none.
 *
 * An instrument is verification tooling written *during* the task to check its deliverables — a claim checker, a probe
 * harness, a shadow runner. Measured: **five consecutive rounds became an arms race against a guard's coverage boundary**,
 * because an instrument owned like a deliverable is audited like one, and an adversarial search on a guard always finds the
 * unguarded dimension. It terminates only when the guard is deleted or its boundary is *declared*.
 *
 * **Declared, never inferred.** Inferring "this script looks like tooling" would re-open the very question the declaration
 * exists to settle, and a task that has not decided whether a path is an instrument has not yet had the conversation that
 * makes the arms race stop. The upstream proposal offered "ownedPaths tiers, or an `instruments: []` list"; this is the
 * list, because a tier would have to be guessed per path while a list is a decision someone made.
 */
export function instrumentPaths(task: { instruments?: string[] }): string[] {
    return [...new Set(task.instruments ?? [])].sort();
}

/** Whether a path is one of the task's declared instruments. */
export function isInstrumentPath(task: { instruments?: string[] }, path: string): boolean {
    const normalized = path.replace(/^\.\//, '');
    return instrumentPaths(task).some((instrument) => instrument === normalized || normalized.startsWith(`${instrument.replace(/\/$/, '')}/`));
}

/**
 * Which **layer** a finding is about (§21.4): the deliverable, governance text, or an instrument.
 *
 * The measurement behind it: assembling the by-layer table took reading ~10 round records by hand, and the answer — *the
 * product stopped producing findings after r18 and every round after was about the tooling* — was visible only in
 * hindsight. Reported per finding so "are we converging, and on what" is one command while the loop is happening.
 */
export type FindingLayer = 'deliverable' | 'governance' | 'instrument';

/**
 * The layer a finding sits in, from the path it names.
 *
 * A finding that names no path is `deliverable`: that is the default the whole gate is built for, and guessing otherwise
 * would let an unlocated finding escape to the advisory layer. When a task declares no instruments, nothing is classified
 * as one — the layer only exists for tasks that asked for it.
 */
export function findingLayer(task: { instruments?: string[]; ownedPaths?: string[] }, path: string | undefined): FindingLayer {
    if (path) {
        if (isInstrumentPath(task, path)) return 'instrument';
        if (isNonCodePath(path)) return 'governance';
    }
    return 'deliverable';
}

/**
 * The content identity of a revision's **code** paths, or `null` when it cannot be derived.
 *
 * `null` is the honest answer, not a fallback: a revision sealed before per-path digests existed cannot say which of its
 * paths are code, and a caller that needs the sub-manifest must then treat the code as unverified rather than assume it is
 * unchanged. Every consumer of this is required to fall back to full invalidation when it gets `null`.
 */
/**
 * The digest keys an owned path covers.
 *
 * An owned path is frequently a **directory** (`scripts`, `packages/x/src/…`), while `pathDigests` is keyed by **files**
 * (699 entries on the measured task, keyed `scripts/assert_acceptance_claims.py`, `tests/test_x.py`, …). Matching the two
 * by string equality therefore found *nothing* for a directory-shaped owned path, so every surface digest was computed over
 * the two documentation files and looked healthy.
 *
 * The consequence was not a slow gate but a **silent one**: the code surface did not move when code moved, so a pass could
 * have been spared for a change it had never seen — the exact failure mode §15 forbids, arrived at by a plausible-looking
 * implementation. The match is a prefix on a path boundary, and a file path also matches itself.
 */
function digestKeysFor(ownedPath: string, key: string): boolean {
    if (key === ownedPath) return true;
    const prefix = ownedPath.endsWith('/') ? ownedPath : `${ownedPath}/`;
    return key.startsWith(prefix);
}

/**
 * The content identity of one surface: the owned paths in it, expanded to the digest entries they cover.
 *
 * `null` when the surface has no entries, or when the revision has no digest table — the honest answer, and the one every
 * consumer must treat as "cannot be spared" rather than "unchanged".
 */
function surfaceDigest(
    revision: Pick<TaskRevision, 'ownedPaths' | 'pathDigests'>,
    paths: string[],
): string | null {
    if (!revision.pathDigests) return null;
    const digests = revision.pathDigests;
    // Expansion is required, not a convenience: an owned *directory* has no digest of its own, so matching paths literally
    // would compute over nothing. Reported per covered key so a change inside a directory is visible.
    const covered = Object.keys(digests)
        .filter((key) => paths.some((path) => digestKeysFor(path, key)))
        .sort();
    if (covered.length === 0) return null;
    return hashContent(covered.map((key) => `${key}\u0000${digests[key]}`).join('\u0001'));
}

/**
 * Every digest key, classified into the three surfaces.
 *
 * **By key, not by owned path.** The measured task owns `scripts/` and `tests/` as *directories* and declares
 * `scripts/assert_acceptance_claims.py` as an instrument — so classifying the *owned path* finds no instrument at all, and
 * the instrument's file stays inside the code surface where its every edit expires the deliverable's pass. That is the
 * defect §24.4 was written to fix, surviving one level down.
 *
 * A key belongs to an instrument when the declaration names it (or a directory above it), and otherwise is split by the
 * code/governance rule. Keys are what the digests are computed over, so this is the level at which the three surfaces
 * actually differ.
 */
export function classifyDigestKeys(
    revision: Pick<TaskRevision, 'ownedPaths' | 'pathDigests'>,
    task: { instruments?: string[] } = {},
): { instruments: string[]; code: string[]; nonCode: string[] } {
    const instruments: string[] = [];
    const code: string[] = [];
    const nonCode: string[] = [];
    for (const key of Object.keys(revision.pathDigests ?? {})) {
        if (isInstrumentPath(task, key)) instruments.push(key);
        else if (isNonCodePath(key)) nonCode.push(key);
        else code.push(key);
    }
    return { instruments: instruments.sort(), code: code.sort(), nonCode: nonCode.sort() };
}

function digestOver(
    revision: Pick<TaskRevision, 'ownedPaths' | 'pathDigests'>,
    keys: string[],
): string | null {
    const digests = revision.pathDigests;
    if (!digests) return null;
    // A declared surface with no digest entries cannot be spoken for: `null` is "cannot be spared", never "unchanged".
    if (keys.length === 0) return null;
    return hashContent(keys.map((key) => `${key}\u0000${digests[key]}`).join('\u0001'));
}

export function codeManifestHash(
    revision: Pick<TaskRevision, 'ownedPaths' | 'pathDigests'>,
    task: { instruments?: string[] } = {},
): string | null {
    return digestOver(revision, classifyDigestKeys(revision, task).code);
}

export function instrumentManifestHash(
    revision: Pick<TaskRevision, 'ownedPaths' | 'pathDigests'>,
    task: { instruments?: string[] } = {},
): string | null {
    return digestOver(revision, classifyDigestKeys(revision, task).instruments);
}

export function governanceManifestHash(
    revision: Pick<TaskRevision, 'ownedPaths' | 'pathDigests'>,
    task: { instruments?: string[] } = {},
): string | null {
    return digestOver(revision, classifyDigestKeys(revision, task).nonCode);
}

/**
 * Every surface a revision has, as one object — the shape a record binds to (§22/§24).
 *
 * One reader instead of three call sites, so a surface cannot be bound by one writer and forgotten by another.
 */
export function surfaceDigests(
    revision: Pick<TaskRevision, 'ownedPaths' | 'pathDigests'> | null,
    task: { instruments?: string[] } = {},
): { code: string | null; governance: string | null; instrument: string | null } {
    if (!revision) return { code: null, governance: null, instrument: null };
    return {
        code: codeManifestHash(revision, task),
        governance: governanceManifestHash(revision, task),
        instrument: instrumentManifestHash(revision, task),
    };
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
