import { readTask } from '../core/task.js';
import { createHash, randomUUID, type Hash } from 'node:crypto';
import { isIgnoredRepositoryPath, maxTreeHashFileBytes, walkRepositoryEntries, walkRepositoryFiles } from '../core/repository-identity.js';
import { hashContent } from '../core/hash.js';
import { changedGitPaths } from '../core/git.js';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { resolveTerminalTask } from '../core/relations.js';
import { createContentHasher } from '../core/hash.js';
import { revisionsDir, currentRevisionPath, revisionPath, tasksDir } from '../core/layout.js';

export interface TaskRevision {
  id: string;
  taskId: string;
  ownedPaths: string[];
  manifestHash: string;
  /**
   * Per-path content digests of the owned set (F2.1 of the finding-lifecycle design).
   *
   * `manifestHash` stays what it was — a single rolling digest, so every historical binding keeps working (I4). This is
   * added *beside* it because a rolling digest cannot answer the question re-verification actually asks: **which files
   * changed since the last pass**. Absent on revisions sealed before the field existed; readers must report that honestly
   * rather than guess a diff.
   */
  pathDigests?: Record<string, string>;
  /**
   * A **declaration-independent** content snapshot of what this revision contained.
   *
   * `pathDigests` is computed over `ownedPaths`, so a change committed outside the declared set is invisible to it — and
   * `git status` is clean once the round commits, so it is invisible there too. Measured on a real task: one commit
   * touched `.gitignore`, `docs/guide.md` and `src/a.ts`, and the record derived from those two sources reported only
   * `src/a.ts`. Anchoring the change surface on the declaration is exactly what AC-2 forbids, so the revision carries
   * the fact itself: every path this revision changed, with its content digest, taken from the repository's own change
   * listing at seal time and then frozen into the revision.
   *
   * Deliberately named for what it is — content, not ownership. `pathDigests` answers "which owned file changed";
   * this answers "what did this revision contain", which is the question the change surface actually asks.
   */
  contentDigests?: Record<string, string>;
  createdAt: string;
  ownershipConflicts?: Array<{ taskId: string; path: string }>;
  ownershipConflictsAcknowledged?: boolean;
}

/**
 * Whether a sealed revision still describes what it is asked about, and **in which of two ways it can have stopped**.
 *
 * The check used to have two states and to hash `revision.ownedPaths` — the declaration frozen when the revision was minted. But
 * a task's declaration can be corrected after that: this change grew its own from 11 paths to 23 with `scope change` +
 * `scope apply`, and the revision kept eleven. So there were **two declarations of one surface**, the check read the older, and
 * `repair-entry.ts` printed "the sealed revision still matches the workspace" — a claim about the workspace decided from a
 * declaration eleven of whose twenty-two paths the check had never hashed.
 *
 * **The two ways are different facts and they call for different actions**: `declaration-moved` says the revision is not about
 * the change's declared surface any more (re-seal, which takes on the new declaration), and `superseded` says the content it
 * described has since changed (the verdict bound to it cannot stand). Collapsing them is what made a refusal say something it had
 * not checked.
 *
 * **And `declaration-moved` is exactly the comparison of the two declarations, and nothing more.** It does *not* say the
 * revision's own content is untouched — the `superseded` check above runs first and hashes that content, so a revision whose
 * owned files changed never reaches this state. Naming the state after the declaration it measured, rather than after the content
 * it did not, is the whole of this comment: the previous wording ("its own content is untouched") was a content claim read off a
 * set comparison, the class this change exists to remove.
 */
export type RevisionStatus =
  | { status: 'current' }
  /**
   * The task's declared paths and the revision's disagree **as sets**, which is the fact this state reports — the payload is
   * `added` (declared by the task, not carried by the revision) and `removed` (carried by the revision, no longer declared).
   * No content of the newly declared paths is read here: whether the revision's own content is unchanged is the `superseded`
   * question, answered above before this branch is reached. Re-seal is the action, because a seal is what adopts the task's new
   * declaration.
   */
  | { status: 'declaration-moved'; revisionOwnedPaths: string[]; taskOwnedPaths: string[]; added: string[]; removed: string[] }
  | { status: 'superseded'; expectedManifestHash: string; revisionManifestHash: string };

/**
 * Mints the revision that identifies this seal, or returns the one that already identifies it.
 *
 * A revision is content-addressed: its id derives from the task, the owned-path manifest hash and the resolved check
 * set, and a seal over byte-identical content resolves to the existing revision instead of minting a new id and
 * silently demoting the previous one — which used to invalidate any review or judge verdict bound to it even though
 * nothing had changed.
 */
export async function createTaskRevision(input: CreateTaskRevisionInput): Promise<TaskRevision> {
  return (await createTaskRevisionIfChanged(input)).revision;
}

/** The same call, reporting whether the revision already existed — the caller may then reuse what it recorded. */
export async function createTaskRevisionIfChanged(input: CreateTaskRevisionInput): Promise<{ revision: TaskRevision; reused: boolean }> {
  const contentRoot = input.contentRoot ?? input.root;
  const ownedPaths = normalizeOwnedPaths(input.root, input.ownedPaths);
  if (ownedPaths.length === 0) throw new Error('A revision requires at least one declared owned path');
  // The identity and owned-manifest facts come from the materialized pre-check
  // snapshot when a seal supplied one. Revision artefacts still live under root.
  const { manifestHash, pathDigests } = await computeBothOwnedDigests(contentRoot, ownedPaths);
  const contentDigests = input.contentDigests ?? await computeContentDigests(contentRoot);
  // The id now covers the content snapshot as well as the owned manifest. The manifest hash field itself is unchanged —
  // every existing binding keeps its meaning — but a revision *exists* for a change outside the declaration, which the
  // own  the owned-path hash alone could not express.
  const id = revisionIdFor(input.taskId, manifestHash, input.checkIds ?? [], contentSnapshotHash(contentDigests));

  const existing = await readTaskRevision(input.root, input.taskId, id).catch(() => null);
  if (existing) {
    // Identical content: the same revision, with any newly acknowledged conflicts folded in.
    const revision: TaskRevision = {
      ...existing,
      // A revision sealed before the field existed gains it here, without being renumbered.
      ...(existing.pathDigests ? {} : { pathDigests }),
      ...(existing.contentDigests ? {} : { contentDigests }),
      ...(input.ownershipConflicts?.length ? { ownershipConflicts: input.ownershipConflicts } : {}),
      ...(input.ownershipConflictsAcknowledged ? { ownershipConflictsAcknowledged: true } : {}),
    };
    await writeFile(currentRevisionPath(input.root, input.taskId), `${JSON.stringify(revision, null, 2)}\n`, 'utf8');
    return { revision, reused: true };
  }

  const revision: TaskRevision = {
    id,
    taskId: input.taskId,
    ownedPaths,
    manifestHash,
    pathDigests,
    contentDigests,
    createdAt: new Date().toISOString(),
    ...(input.ownershipConflicts?.length ? { ownershipConflicts: input.ownershipConflicts } : {}),
    ...(input.ownershipConflictsAcknowledged ? { ownershipConflictsAcknowledged: true } : {}),
  };
  const directory = revisionsDir(input.root, input.taskId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${revision.id}.json`), `${JSON.stringify(revision, null, 2)}\n`, 'utf8');
  await writeFile(currentRevisionPath(input.root, input.taskId), `${JSON.stringify(revision, null, 2)}\n`, 'utf8');
  return { revision, reused: false };
}

export interface CreateTaskRevisionInput {
  /** Workspace where Kata persists the revision artefacts. */
  root: string;
  /** Immutable pre-check content root when sealing in isolation; defaults to root. */
  contentRoot?: string;
  /** Digests frozen from contentRoot before any check can run. */
  contentDigests?: Record<string, string>;
  taskId: string;
  ownedPaths: string[];
  checkIds?: string[];
  ownershipConflicts?: Array<{ taskId: string; path: string }>;
  ownershipConflictsAcknowledged?: boolean;
}

/**
 * The content-derived revision id: same task, same content, same check set, same revision.
 *
 * `contentDigestHash` is the declaration-independent half, and it is what makes a revision exist for a change the
 * declaration does not cover. Without it, a round that edited a path outside its owned set and committed produced **the
 * same revision id** as the round before it — so the change was not merely invisible, it was not a revision at all.
 * Measured: editing and committing `src/outside.ts` with `src/owned.ts` owned returned the existing id, and the change
 * surface answered `unchanged`.
 *
 * Optional so a caller with no snapshot (a pre-existing revision being read back, a test that names an id directly)
 * keeps the historical derivation and therefore the historical id — the transition must not renumber revisions that
 * nothing has re-sealed.
 */
export function revisionIdFor(taskId: string, manifestHash: string, checkIds: string[], contentDigestHash?: string): string {
  const digest = hashContent(JSON.stringify({
    taskId,
    manifestHash,
    checkIds: [...checkIds].sort(),
    ...(contentDigestHash ? { contentDigestHash } : {}),
  }));
  return `revision-${digest.slice(0, 16)}`;
}

/** A stable digest over a content snapshot, so the id derives from content rather than from map ordering. */
export function contentSnapshotHash(contentDigests: Record<string, string>): string {
  const ordered = Object.keys(contentDigests).sort();
  return hashContent(JSON.stringify(ordered.map((path) => [path, contentDigests[path]])));
}

export async function readTaskRevision(root: string, taskId: string, revisionId: string): Promise<TaskRevision> {
  return JSON.parse(await readFile(revisionPath(root, taskId, revisionId), 'utf8')) as TaskRevision;
}

export async function readCurrentTaskRevision(root: string, taskId: string): Promise<TaskRevision | null> {
  try {
    return JSON.parse(await readFile(currentRevisionPath(root, taskId), 'utf8')) as TaskRevision;
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

export async function revisionStatus(root: string, revision: TaskRevision, taskId?: string): Promise<RevisionStatus> {
  // Freshness remains scoped to the declared manifest. `contentDigests` names
  // what the sealed revision contained and powers its delta; using the whole
  // snapshot here would make a later unrelated file invalidate valid evidence.
  const manifestHash = await computeManifestHash(root, revision.ownedPaths);
  if (manifestHash !== revision.manifestHash) {
    return { status: 'superseded', expectedManifestHash: manifestHash, revisionManifestHash: revision.manifestHash };
  }
  // **And the declaration itself can have moved**, which the hash above cannot see because it is taken over the old one. A
  // revision whose owned paths are no longer the task's is not about the change's declared surface — and calling that
  // `current` is what let a seal refusal claim the workspace matched while eleven declared paths were never hashed.
  if (!taskId) return { status: 'current' };
  // **A task that could not be read is an error, not an empty declaration** (rba7-f4). `readTask` validates, so a
  // schema-drifted or unparseable `task.json` throws; the previous `.catch(() => null)` plus `?? []` converted that throw into
  // `taskOwnedPaths: []`, and every revision then read as `declaration-moved` carrying a declaration the task does not have.
  // An absence (ENOENT) is genuinely no declaration to compare and stays `current`; anything else is rethrown, which is the
  // line `readCurrentTaskRevision` above already draws.
  const task = await readTask(root, taskId).catch((error: unknown) => {
    const cause = (error as { cause?: unknown } | null)?.cause;
    if (typeof cause === 'object' && cause !== null && (cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!task) return { status: 'current' };
  const taskOwnedPaths = normalizeOwnedPaths(root, task.ownedPaths ?? []);
  const revisionOwnedPaths = [...revision.ownedPaths];
  const same = taskOwnedPaths.length === revisionOwnedPaths.length
    && taskOwnedPaths.every((path: string) => revisionOwnedPaths.includes(path));
  if (!same) {
    // The payload is the **declaration fact**, split into the two directions an operator acts on: paths the task declares
    // that the revision does not carry, and paths the revision carries that the task no longer declares. Neither names a
    // digest, because no digest was taken of the newly declared paths here.
    const revisionSet = new Set(revisionOwnedPaths);
    const taskSet = new Set(taskOwnedPaths);
    return {
      status: 'declaration-moved',
      revisionOwnedPaths,
      taskOwnedPaths,
      added: taskOwnedPaths.filter((path) => !revisionSet.has(path)),
      removed: revisionOwnedPaths.filter((path) => !taskSet.has(path)),
    };
  }
  return { status: 'current' };
}

/**
 * **The one question every consumer asks**: does this sealed revision still describe what it is asked about?
 *
 * It exists because `revisionStatus` acquired a third state and one consumer kept asking the two-state question —
 * `orchestrator.ts` read `status?.status === 'superseded'`, so a `declaration-moved` revision took the readiness path while
 * `distill-gates.ts` refused the same revision's evidence (rba7-f2). The two answers disagreed because each consumer spelled
 * the comparison out itself. Routing every consumer through one predicate is what makes the next state impossible to answer
 * two ways: there is nothing to spell out, so there is nothing to spell differently.
 */
export function revisionIsCurrent(status: RevisionStatus): boolean {
  return status.status === 'current';
}

/**
 * Feeds one owned-path traversal into the rolling manifest digest and, when asked, the per-path table.
 *
 * `computeManifestHash` and `computePathDigests` each walked the same tree, so a seal read and hashed every owned
 * file twice before a single check started (L1-02). The traversal and the order are identical, so asking for both
 * costs one walk and produces byte-identical output for each. Callers that need only one of the two still pay for
 * only one.
 *
 * The walk is `walkRepositoryEntries` (one file at a time) rather than `walkRepositoryFiles`: the owned set used to be
 * materialised in full just to hash it. Same ignore policy, same size rule (owned-path hashing has no size cap), same
 * `localeCompare` order — so the digests do not move.
 */
async function feedOwnedTree(
  root: string,
  ownedPaths: string[],
  manifest: Hash,
  pathDigests: Record<string, string> | null,
): Promise<void> {
  for (const path of normalizeOwnedPaths(root, ownedPaths)) {
    manifest.update(path);
    manifest.update('\0');
    const fullPath = join(root, path);
    let entry: Awaited<ReturnType<typeof stat>> | null = null;
    try {
      entry = await stat(fullPath);
    } catch {
      entry = null;
    }

    if (entry?.isDirectory()) {
      const relativeDir = relative(root, fullPath).replaceAll('\\', '/');
      for await (const file of walkRepositoryEntries(root, relativeDir ? { under: relativeDir } : {})) {
        manifest.update(file.path);
        manifest.update('\0');
        manifest.update(file.content);
        manifest.update('\0');
        if (pathDigests) pathDigests[file.path] = hashContent(file.content);
      }
    } else if (entry?.isFile()) {
      const content = await readFile(fullPath);
      manifest.update(content);
      if (pathDigests) pathDigests[path] = hashContent(content);
    } else if (entry) {
      manifest.update('[unsupported]');
      if (pathDigests) pathDigests[path] = hashContent('[unsupported]');
    } else {
      manifest.update('[missing]');
      if (pathDigests) pathDigests[path] = hashContent('[missing]');
    }
    manifest.update('\0');
  }
}

/** Both owned-tree digests from one traversal — what a seal needs. */
export async function computeBothOwnedDigests(
  root: string,
  ownedPaths: string[],
): Promise<{ manifestHash: string; pathDigests: Record<string, string> }> {
  const pathDigests: Record<string, string> = {};
  const manifest = createContentHasher();
  await feedOwnedTree(root, ownedPaths, manifest, pathDigests);
  return { manifestHash: manifest.digest('hex'), pathDigests };
}

/**
 * The content snapshot a revision freezes: the declared owned set **plus** everything else the repository reports as
 * changed, each with a digest.
 *
 * The union is the point. The owned set alone cannot answer "what did this revision change" — that is the defect AC-2
 * names — and the change listing alone cannot answer it after the round commits. Taking both at seal time, when the
 * listing is still honest, and freezing the result is what makes the answer durable.
 *
 * A path outside any owned path is hashed the same way an owned one is, so the two kinds are comparable; a path that no
 * longer exists keeps its digest from the manifest walk (a removal must not read as "never existed").
 */
export async function computeContentDigests(root: string): Promise<Record<string, string>> {
  // Walked from the tree, **not** from `git status`.
  //
  // Using the change listing was the same trap one level down: it reports *uncommitted* work, so a round that committed
  // before sealing produced a snapshot identical to its predecessor and the revision was reused — measured: editing and
  // committing `src/outside.ts` returned the base id and the content snapshot still listed only `src/owned.ts`. A
  // snapshot that depends on when the author happened to commit is not a content identity.
  //
  // The walk is bounded by the same ignore policy and size cap as the tree hash, so this is a fingerprint over the
  // repository rather than a read of every model file for the sake of bookkeeping.
  const digests: Record<string, string> = {};
  for await (const file of walkRepositoryEntries(root, { maxFileBytes: maxTreeHashFileBytes })) {
    digests[file.path] = hashContent(file.content);
  }
  return digests;
}

export async function computeManifestHash(root: string, ownedPaths: string[]): Promise<string> {
  const manifest = createContentHasher();
  await feedOwnedTree(root, ownedPaths, manifest, null);
  return manifest.digest('hex');
}
/**
 * **`computePathDigest` was deleted, because nothing asks for one path's digest.** The two callers that walk a tree each
 * need the whole set at once and have their own walker: `computeManifestHash` above, which hashes the declared surface into
 * the revision identity, and the ledger's `freezeSubject`, which freezes a subject's per-path digests. A third walker for a
 * single path had no caller — and a second implementation of "what is this path's digest" is exactly the shape that lets
 * two of them disagree about the sentinels for unreadable and absent content.
 */

/**
 * The owned set as a path → digest map, ordered so the result is deterministic.
 *
 * A directory owned path is expanded to the files it contains: a single digest per directory would answer "something in
 * here changed" and nothing more, which is precisely the question this exists to answer precisely.
 */
export async function computePathDigests(root: string, ownedPaths: string[]): Promise<Record<string, string>> {
  const pathDigests: Record<string, string> = {};
  await feedOwnedTree(root, ownedPaths, createContentHasher(), pathDigests);
  return pathDigests;
}

/** Owned-path hashing shares the repository's ignore policy, and reads what it is responsible for (no size cap). */
async function hashDirectoryRecursive(dirPath: string, root: string, hash: ReturnType<typeof createHash>): Promise<void> {
  const relativeDir = relative(root, dirPath).replaceAll('\\', '/');
  for (const file of await walkRepositoryFiles(root, relativeDir ? { under: relativeDir } : {})) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(file.content);
    hash.update('\0');
  }
}


export async function findOwnershipConflicts(
  root: string,
  taskId: string,
  ownedPaths: string[],
): Promise<Array<{ taskId: string; path: string }>> {
  const tasksRoot = tasksDir(root);
  let entries: string[] = [];
  try { entries = await readdir(tasksRoot); } catch { return []; }
  const normalized = normalizeOwnedPaths(root, ownedPaths);
  const conflicts: Array<{ taskId: string; path: string }> = [];
  for (const otherTaskId of entries.filter((id) => id !== taskId)) {
    try {
      const terminal = await resolveTerminalTask(root, otherTaskId);
      if (terminal.taskId === taskId) continue;
      if (terminal.redirects.length > 0) continue;
      try {
        const state = JSON.parse(await readFile(join(tasksRoot, terminal.taskId, 'current-state.json'), 'utf8')) as { phase?: string };
        if (state.phase === 'archive') continue;
      } catch { /* legacy task without state remains an active ownership claim */ }
      const task = JSON.parse(await readFile(join(tasksRoot, otherTaskId, 'task.json'), 'utf8')) as { ownedPaths?: string[] };
      for (const path of normalizeOwnedPaths(root, task.ownedPaths ?? [])) {
        // Directory-granularity overlap is the cheap test and the common case; when two claims do overlap, the conflict
        // is reported at the files both tasks actually own, so "tests/" against "tests/" does not read as a total
        // collision when the two tasks touch different files inside it.
        if (!normalized.some((owned) => pathsOverlap(owned, path))) continue;
        const shared = await sharedOwnedFiles(root, normalized, path);
        if (shared.length > 0) conflicts.push(...shared.map((file) => ({ taskId: otherTaskId, path: file })));
      }
    } catch { /* non-task directory */ }
  }
  return conflicts;
}

/** The files two ownership claims both cover, or the two claimed paths themselves when neither resolves to files. */
async function sharedOwnedFiles(root: string, mine: string[], theirs: string): Promise<string[]> {
  const [mineFiles, theirFiles] = await Promise.all([
    ownedFiles(root, mine),
    ownedFiles(root, [theirs]),
  ]);
  if (mineFiles.size === 0 || theirFiles.size === 0) {
    // A path that does not exist yet (a file the task will create) has no file set: report the claim itself.
    return [...mine, theirs].some((path) => path.length > 0) ? [theirs] : [];
  }
  return [...theirFiles].filter((file) => mineFiles.has(file)).sort();
}

async function ownedFiles(root: string, ownedPaths: string[]): Promise<Set<string>> {
  const files = new Set<string>();
  for (const ownedPath of ownedPaths) {
    try {
      const info = await stat(join(root, ownedPath));
      if (info.isFile()) {
        files.add(ownedPath);
        continue;
      }
      if (!info.isDirectory()) continue;
      for (const file of await walkRepositoryFiles(root, { under: ownedPath })) files.add(file.path);
    } catch {
      // A declared path that does not exist yet contributes no files.
    }
  }
  return files;
}

export async function workspaceDrift(root: string, ownedPaths: string[]): Promise<string[]> {
  const owned = normalizeOwnedPaths(root, ownedPaths);
  return changedRepositoryPaths(root)
    .filter((path) => !isIgnoredWorkspacePath(path))
    .filter((path) => !owned.some((ownedPath) => pathsOverlap(ownedPath, path)))
    .sort();
}

export async function inferOwnedPathsFromWorkspace(root: string): Promise<string[]> {
  return changedRepositoryPaths(root)
    .filter((path) => !isIgnoredWorkspacePath(path))
    .sort();
}

/** @see core/git.ts — the one reader of repository state. */
function changedRepositoryPaths(root: string): string[] {
  return changedGitPaths(root);
}

/** Drift and ownership inference exclude exactly what the tree hash excludes: one policy, one answer. */
function isIgnoredWorkspacePath(path: string): boolean {
  return isIgnoredRepositoryPath(path);
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function normalizeOwnedPaths(root: string, paths: string[]): string[] {
  return [...new Set(paths.map((path) => {
    const normalized = relative(root, resolve(root, path)).replaceAll('\\', '/');
    if (!normalized || normalized === '..' || normalized.startsWith('../')) {
      throw new Error(`Task-owned path must be inside the repository: ${path}`);
    }
    return normalized;
  }))].sort();
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
