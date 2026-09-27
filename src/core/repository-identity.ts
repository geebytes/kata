import { llmwikiDirName } from './layout.js';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createContentHasher } from './hash.js';

/**
 * What counts as part of the repository, for identity purposes.
 *
 * "What is this repository?" had three answers — the freshness hash's ignore table, the revision manifest's copy of it,
 * and a differently scoped table for drift and ownership inference — so the hash, the revision manifest and the drift
 * view could disagree about a path. They read this one policy now: a path the tree hash excludes is a path drift does
 * not report, and a path the manifest excludes is one it does not hash.
 */

/** Directory names that never carry identity: toolches, caches, and kata's own state. */
export const ignoredDirectoryNames: readonly string[] = [
    '.git',
    '.kata',
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
 * Directories and files excluded for what they are rather than by size. Model weights and dataset dumps used to be
 * excluded only because they happen to exceed the per-file size cap; naming them says the intent and keeps the walk
 * from reading a multi-gigabyte file to find out.
 */
export const ignoredHeavyPaths: readonly string[] = ['.models'];

/** File names or suffixes that are never part of identity. */
export const ignoredFileSuffixes: readonly string[] = ['.gguf', '.safetensors', '.onnx', '.ckpt'];

/** Generation-managed trees: kata writes them, so their contents are not the repository's own work. */
export const ignoredPathPrefixes: readonly string[] = ['.github/hooks', '.github/skills', '.github/instructions'];

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
