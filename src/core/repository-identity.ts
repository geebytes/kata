import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { createContentHasher } from './hash.js';

/**
 * What counts as part of the repository, for identity purposes.
 *
 * "What is this repository?" had three answers — the freshness hash's ignore table, the revision manifest's copy of it,
 * and a differently scoped table for drift and ownership inference — so the hash, the revision manifest and the drift
 * view could disagree about a path. They read this one policy now: a path the tree hash excludes is a path drift does
 * not report, and a path the manifest excludes is one it does not hash.
 */

/**
 * The knowledge store's directory name.
 *
 * **It lives here because the policy names it, and it moved here to break a cycle.** It was declared in `core/layout.ts`
 * and imported by this module — one-way, until `layout` started asking this module what is not source, at which point the
 * two modules were each half-initialised depending on which loaded first and `ignoredDirectoryNames` silently gained an
 * `undefined` element. A constant that a policy list is made of belongs to the policy; `layout` re-exports it so existing
 * importers keep working.
 */
export const llmwikiDirName = '.llmwiki';

/**
 * Directory names that never carry identity: toolches, caches, and the machinery of the workflow.
 *
 * **`.kata` is deliberately not here.** It used to be, grouped with `.git` and `node_modules` on the reading that kata's
 * state is runtime rather than repository content. That reading is wrong for the part that matters: `.kata/tasks/` holds
 * what a change was, what was concluded about it, who decided what, and the verdict history — the trace and the project's
 * evolution, which is exactly what "identity" is for. The machinery is excluded by *path* instead of by this table
 * (`isIgnoredRepositoryPath` below), so a revision's content summary carries the record and not the worktrees.
 */
export const ignoredDirectoryNames: readonly string[] = [
    '.git',
    llmwikiDirName,
    '.pytest_cache',
    '.mypy_cache',
    '.ruff_cache',
    '.coverage',
    '__pycache__',
    'node_modules',
    'dist',
    '.codex',
    '.claude',
    '.opencode',
];

/**
 * Directory names a **source walk** does not descend into.
 *
 * **Derived from the policy, never restated.** Two modules kept their own answer to "what is not content" — a descendant
 * scan in `core/layout.ts` with `SKIP_DIRS` and a source walk with a scratch copy in `quality/wiring-check.ts` with `SKIP` —
 * and the lists disagreed with this table and with each other. One disagreement was a live defect rather than untidiness:
 * `SKIP_DIRS` held `.kata`, which is exactly where the descendant roots it was looking for live (`.kata/worktrees/<id>`), so
 * that scan could never find one and the command failed with "No Kata workspace owns task …" and a remedy that could not run.
 *
 * The three extra names are a **walk** judgement, not an identity one: a tree called `target`, `build`, `venv` or `.venv`
 * holds build output rather than source, so a walk over source skips it — while identity still hashes it, because "what a
 * change declared" and "what source exists to read" are different questions and answering one by editing the other would
 * quietly shrink what a revision covers.
 */
export const nonSourceDirectoryNames: readonly string[] = [
    ...ignoredDirectoryNames,
    'tmp',
    'target',
    'build',
    'venv',
    '.venv',
];

/** True when a source walk refuses to descend into a directory of this name. */
export function isNonSourceDirectory(name: string): boolean {
    return nonSourceDirectoryNames.includes(name);
}

/**
 * Directory names that hold **this machine's own state** rather than the repository's.
 *
 * Named apart from the policy because it answers a different question: `.kata/` is content (its records are the project's
 * own evolution — see `ignoredDirectoryNames`) and a scan for records must descend into it, while a *copy* of the repository
 * for a scratch run must not carry 150 MB of worktrees. One list could not serve both, and serving both with one list is
 * what made the descendant scan blind to the tree it was looking for.
 */
export const localMachineryDirectoryNames: readonly string[] = ['.kata'];

/** True when a directory belongs to this machine or session rather than to the repository. */
export function isLocalMachineryDirectory(name: string): boolean {
    return localMachineryDirectoryNames.includes(name);
}

/**
 * Directories and files excluded for what they are rather than by size. Model weights and dataset dumps used to be
 * excluded only because they happen to exceed the per-file size cap; naming them says the intent and keeps the walk
 * from reading a multi-gigabyte file to find out.
 */
export const ignoredHeavyPaths: readonly string[] = ['.models'];

/** File names or suffixes that are never part of identity. */
export const ignoredFileSuffixes: readonly string[] = ['.gguf', '.safetensors', '.onnx', '.ckpt'];

/**
 * Generation-managed trees, plus kata's own machinery.
 *
 * **The second group is why `.kata` left `ignoredDirectoryNames`.** The trace under `.kata/tasks/` and the knowledge under
 * `.kata/wiki/` are the repository's own work and belong in identity; a worktree is a second copy of the source, a runtime
 * pointer belongs to one session, a lock is held by one process, and `.kata/evidence/` holds what one verification run
 * produced. Excluding them by prefix keeps "what is this repository" answering with the record rather than with 150 MB of
 * checkouts — measured before this change: `.kata/worktrees/` alone was 150 MB across 10,195 files.
 */
export const ignoredPathPrefixes: readonly string[] = [
    '.github/hooks',
    '.github/skills',
    '.github/instructions',
    '.kata/worktrees',
    '.kata/runtime',
    '.kata/locks',
    '.kata/evidence',
    '.kata/kt-scratch',
    '.kata/kt-master',
    // **The whole trace, not a list of its parts.** Kata writes these files itself as a change progresses, so the working
    // tree is dirty by definition while a change is alive — measured, 467 of the 485 paths `git status` reported were
    // `.kata/` records. Leaving them in the drift surface makes every seal fail on the records the previous seal wrote,
    // and enumerating the machinery file by file is the same rule stated twice: the list below was six names, while
    // the records number in the hundreds and grow with every change.
    //
    // `.gitignore` decides what git carries (the trace is admitted by name); this table decides what the *identity* and
    // *drift* surfaces count, and drift asks about code. The two are checked against each other by
    // `owner-rule-covers-evidence-and-trace.test.ts`, because two tables that must agree will not agree by memory.
    '.kata/tasks',
    // The knowledge store, by the same argument: `wiki enrich` writes and re-registers pages while a change is alive, and
    // a page is kata's own output rather than the code under review.
    '.kata/wiki',
    // Everything else under `.kata/` that kata generates: the vendored schema copies `initLayout` writes, the adapter
    // descriptions, and the generated skills index. None of it is the code under review, and all of it is rewritten by
    // the tooling, so a drift surface that counts it reports kata's own bookkeeping as the user's uncommitted work.
    '.kata/schemas',
    '.kata/adapters',
    '.kata/skills-index.md',
];

/**
 * The largest file the *whole-tree* identity walk reads. Owned-path hashing has no cap: the manifest's job is to notice
 * that any owned file changed, while the tree hash is a cheap fingerprint over everything.
 */
export const maxTreeHashFileBytes = 2_000_000;

function segments(path: string): string[] {
    return path.split('/').filter(Boolean);
}

/** True when a single directory entry name is excluded, whatever its parent. */
export function isIgnoredRepositoryName(name: string): boolean {
    return ignoredDirectoryNames.includes(name)
        || ignoredHeavyPaths.includes(name)
        || ignoredFileSuffixes.some((suffix) => name.endsWith(suffix));
}

/** True when a repository-relative path is excluded, considering every one of its segments. */
export function isIgnoredRepositoryPath(path: string): boolean {
    const normalized = path.replaceAll('\\', '/').replace(/^\.\/+/, '');
    if (!normalized) return false;
    if (segments(normalized).some((segment) => isIgnoredRepositoryName(segment))) return true;
    return ignoredPathPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

export interface RepositoryFile {
    path: string;
    absolutePath: string;
    content: Buffer;
}

export interface WalkOptions {
    /** Restrict the walk to this repository-relative subtree (one owned path, in the manifest's case). */
    under?: string;
    /** Skip files larger than this instead of reading them. Defaults to no cap. */
    maxFileBytes?: number;
}

/**
 * Walks the repository with the shared ignore policy, sorted by path.
 *
 * The size budget is the caller's decision and is stated at the call site: the tree hash caps it so it never reads a
 * model file to discover it is one, while owned-path hashing reads what it is responsible for.
 */
/**
 * The included repository-relative paths, sorted, **without reading a single file's content**.
 *
 * The path list is what an identity consumer actually needs in order; the bytes can be read one at a time
 * afterwards. Separating the two is what lets a whole-tree hash hold one file instead of the whole tree.
 */
/**
 * Every path the repository itself declares ignored, as git reports it.
 *
 * One `git status` call over the whole tree, answered by the authority on gitignore semantics. A repository that is not
 * under git has declared nothing, and an unavailable git narrows the walk to the built-in policy rather than failing it —
 * the same best-effort contract the rest of the identity reads follow.
 */
async function gitIgnoredPaths(root: string): Promise<Set<string>> {
    const ignored = new Set<string>();
    try {
        const { runGit } = await import('./git.js');
        const result = runGit(root, ['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=all']);
        if (!result.ok) return ignored;
        for (const token of result.stdout.split('\0').filter(Boolean)) {
            if (!token.startsWith('!! ')) continue;
            const reported = token.slice(3).replaceAll('\\', '/');
            if (!reported) continue;
            // `--ignored=matching` reports an ignored directory as one entry (`tmp/`), and git's own trailing slash is not
            // part of the path. Both forms are stored, so a lookup by either a directory or a file matches — the walk
            // prunes the subtree by looking up the entry it is standing on.
            ignored.add(reported);
            ignored.add(reported.replace(/\/+$/, ''));
            const bare = reported.replace(/\/+$/, '');
            if (bare) ignored.add(`${bare}/`);
        }
    } catch {
        return ignored;
    }
    return ignored;
}

export async function listRepositoryFiles(root: string, options: WalkOptions = {}): Promise<string[]> {
    const paths: string[] = [];
    // The repository's own declaration is consulted through git, the authority on its own ignore semantics. Re-deriving
    // `.gitignore` here would be a second implementation that disagrees at the edges (negations, nested files,
    // `.git/info/exclude`). Measured: this project declares `tmp/` for evidence and working files, yet a review brief
    // listed `tmp-verify-brief.json` — the reviewer's own scratch file — as a path under review (§1.1).
    const declaredIgnored = await gitIgnoredPaths(root);

    async function visit(directory: string): Promise<void> {
        let entries;
        try {
            entries = await readdir(directory, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (isIgnoredRepositoryName(entry.name)) continue;
            const absolutePath = join(directory, entry.name);
            const repositoryPath = relative(root, absolutePath).replaceAll('\\', '/');
            if (isIgnoredRepositoryPath(repositoryPath)) continue;
            // git reports an ignored *directory* by its directory path, so matching the entry itself is enough to prune the
            // whole subtree — which is what makes the walk cheap as well as correct.
            if (declaredIgnored.has(repositoryPath)) continue;
            if (entry.isDirectory()) {
                await visit(absolutePath);
                continue;
            }
            if (!entry.isFile()) continue;
            if (options.maxFileBytes !== undefined) {
                const info = await stat(absolutePath);
                if (info.size > options.maxFileBytes) continue;
            }
            paths.push(repositoryPath);
        }
    }

    const start = options.under ? join(root, options.under) : root;
    // **One rule for every declaration.** What a declaration names is expanded under the same content policy as the rest of
    // the repository: a declared build directory or cache expands to nothing, a declared source directory excludes its build
    // output, and a declared *file* is recorded whatever its name. Two earlier shapes of this were wrong in opposite
    // directions and each was measured: recording a never-content root's contents unconditionally made the same physical
    // directory answer differently depending on how the declaration was spelled (`build/` recorded, `build/*` did not), and
    // filtering silently let a declaration expand to nothing while the seal minted a revision whose identity had no content.
    // The second is closed by refusing that declaration (see the seal), not by recording content the repository says is not
    // content.
    if (options.under && isIgnoredRepositoryPath(options.under)) return [];
    await visit(start);
    return paths.sort((left, right) => left.localeCompare(right));
}

/**
 * The same walk, one file at a time.
 *
 * Yields exactly what `walkRepositoryFiles` returns — same ignore policy, same size budget, same `localeCompare`
 * order — but reads each file only when the consumer is ready for it, so hashing a repository is O(one file) in
 * memory instead of O(the tree). Callers that need the bytes all at once keep using `walkRepositoryFiles`.
 */
export async function* walkRepositoryEntries(root: string, options: WalkOptions = {}): AsyncGenerator<RepositoryFile> {
    for (const path of await listRepositoryFiles(root, options)) {
        yield { path, absolutePath: join(root, path), content: await readFile(join(root, path)) };
    }
}

/**
 * Walks the repository with the shared ignore policy, sorted by path.
 *
 * The size budget is the caller's decision and is stated at the call site: the tree hash caps it so it never reads a
 * model file to discover it is one, while owned-path hashing reads what it is responsible for.
 *
 * This is the materialising shape, kept for callers that genuinely want every file's bytes at once; it is a thin
 * wrapper over the streaming walk so the two can never disagree about what the repository contains.
 */
export async function walkRepositoryFiles(root: string, options: WalkOptions = {}): Promise<RepositoryFile[]> {
    const files: RepositoryFile[] = [];
    for await (const file of walkRepositoryEntries(root, options)) files.push(file);
    return files;
}

/**
 * The repository-relative form of a set of declarations, canonicalised.
 *
 * **One derivation, because two were measured to disagree.** The seal canonicalised its owned paths and the ledger did not,
 * so `./src/pkg` was `src/pkg` for the revision and `./src/pkg` for the ledger's subject — and the ledger then rebuilt its
 * keys by slicing the raw declaration, which landed mid-name (`./src/pkg/sted/deep.ts` for `src/pkg/nested/deep.ts`) and
 * collapsed distinct files onto one key, so editing a source file left the frozen subject byte-identical.
 *
 * Throws on a declaration that resolves outside the repository, which is the seal's rule and now the ledger's too.
 */
export function normalizeDeclaredPaths(root: string, declared: readonly string[]): string[] {
    return [...new Set(declared.map((path) => {
        const normalized = relative(root, resolve(root, path)).replaceAll('\\', '/');
        if (!normalized || normalized === '..' || normalized.startsWith('../')) {
            throw new Error(`Task-owned path must be inside the repository: ${path}`);
        }
        return normalized;
    }))].sort();
}

/**
 * What a set of declarations covers, in the walk's own coordinates.
 *
 * The caller decides what to do about a declaration it cannot read — the seal records a sentinel, the ledger refuses by name
 * — but *which paths a declaration covers* is one answer, and it is the walk's: a directory expands to the paths
 * `listRepositoryFiles` returns for it (the repository's own git declaration included, no depth cap, repository
 * coordinates), and a file is itself.
 *
 * **The filter applies to what the walk descends into, never to what was declared.** A declaration is the operator's own
 * statement about their change, and the identity has always honoured it without a cap or a filter ("owned-path hashing reads
 * what it is responsible for"); the walk's exclusions are for what a declaration *silently* pulls in. An independent round
 * measured the difference this makes: refusing a git-ignored directory *root* put the ledger and the seal at odds for that
 * input, while expanding it keeps them equal and reports the declaration as `neverContent` so the operator can see what they
 * declared.
 */
export async function declaredContentPaths(
    root: string,
    declared: readonly string[],
): Promise<{ paths: string[]; unreadable: string[]; neverContent: string[] }> {
    const paths = new Set<string>();
    const unreadable: string[] = [];
    const neverContent: string[] = [];
    for (const declaration of normalizeDeclaredPaths(root, declared)) {
        let entry: Awaited<ReturnType<typeof stat>> | null = null;
        try {
            entry = await stat(join(root, declaration));
        } catch {
            entry = null;
        }
        if (entry?.isDirectory()) {
            // Reported, not refused: the operator declared this root, and the identity records what it declared.
            if (isIgnoredRepositoryPath(declaration) || await isDeclaredIgnored(root, declaration)) neverContent.push(declaration);
                    for (const path of await listRepositoryFiles(root, { under: declaration })) paths.add(path);
        } else if (entry?.isFile()) {
            paths.add(declaration);
        } else {
            unreadable.push(declaration);
        }
    }
    return { paths: [...paths].sort((left, right) => left.localeCompare(right)), unreadable, neverContent };
}

/** Whether the repository itself declares this path ignored, asked the same way the walk asks it. */
async function isDeclaredIgnored(root: string, path: string): Promise<boolean> {
    const ignored = await gitIgnoredPaths(root);
    return ignored.has(path) || ignored.has(`${path}/`) || ignored.has(path.replace(/\/+$/, ''));
}

/** The identity of the current repository contents: a hash over the paths and contents of what the walk returned. */
export async function repositoryTreeHash(root: string): Promise<string> {
    const hash = createContentHasher();
    for await (const file of walkRepositoryEntries(root, { maxFileBytes: maxTreeHashFileBytes })) {
        hash.update(file.path);
        hash.update('\0');
        hash.update(file.content);
        hash.update('\0');
    }
    return hash.digest('hex');
}
