import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listRepositoryFiles } from '../core/repository-identity.js';

/**
 * The import-graph fallback for affected-test discovery (§3.3).
 *
 * The design asks for "an AST/import fallback when the index is stale or lacks TypeScript coverage", and on this
 * repository that is not a hypothetical: the CodeGraph index is rooted at the *parent* project, reports
 * `typescript 4` for a worktree of 259 TypeScript files, and answers `No test files affected by the changed files`
 * about a module that 26 test files import. A discovery that accepts that answer reports a silent false negative.
 *
 * So the fallback answers the same question from the one fact that cannot be stale — the files' own imports:
 *
 *   given the implementation paths the matrix declares, which test files reach any of them?
 *
 * Two properties matter as much as the answer:
 *
 *  - **Attribution is preserved.** A candidate names the implementation paths that dragged it in, because that is what a
 *    reviewer reads; a flat "these tests are affected" list would lose it.
 *  - **A cap is never silent.** The scan is bounded, and hitting a bound is reported as *cannot answer* rather than
 *    returned as a smaller answer. That is the same rule the bounded CodeGraph pool follows.
 */

/** Code extensions whose imports are worth following. Anything else is not part of a module graph. */
const codeExtensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** Resolution suffixes, in the order TypeScript/Node would try them for a relative specifier. */
const resolutionSuffixes = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Whether a repository-relative path looks like a test file.
 *
 * One definition, shared with the CodeGraph reader: two predicates would drift, and the drift would show up as a
 * candidate silently dropped from one source and kept by the other.
 */
export function isAffectedTestPath(value: string): boolean {
    return !value.startsWith('/')
        && !value.includes('..')
        && /(?:^|\/)(?:[^/]+\.)?(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|(?:^|\/)[^/]+_test\.py$/.test(value);
}

/** Every module specifier a file imports, by any of the four forms that create a runtime edge. */
const importPatterns = [
    // `import x from '…'`, `export * from '…'`, `export { y } from '…'`
    /(?:^|[^\w$])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g,
    // side-effect import: `import '…'`
    /(?:^|[^\w$])import\s*['"]([^'"]+)['"]/g,
    // dynamic import: `import('…')`
    /(?:^|[^\w$])import\s*\(\s*['"]([^'"]+)['"]/g,
    // CommonJS: `require('…')`
    /(?:^|[^\w$])require\s*\(\s*['"]([^'"]+)['"]/g,
];

function importedSpecifiers(source: string): string[] {
    const specifiers = new Set<string>();
    for (const pattern of importPatterns) {
        for (const match of source.matchAll(pattern)) {
            const specifier = match[1];
            if (specifier.startsWith('.')) specifiers.add(specifier);
        }
    }
    return [...specifiers];
}

function withoutExtension(value: string): string {
    for (const extension of codeExtensions) {
        if (value.endsWith(extension)) return value.slice(0, -extension.length);
    }
    return value;
}

export interface ImportGraphResult {
    /** For each queried path, the test files that reach it. Empty means the scan looked and found none. */
    importers: Map<string, string[]>;
    /**
     * The queried paths the scan could actually resolve to a file in the repository.
     *
     * A path outside `covered` is one the scan is in no position to answer about — a declared path that does not exist,
     * or one the walk never saw. The caller must not read "not covered" as "no importers": that would turn a missing
     * file into an all-clear.
     */
    covered: Set<string>;
}

export interface ImportGraphLimits {
    /** Largest number of files the walk may read. Reaching it is `cannot answer`, never a partial answer. */
    maxFiles?: number;
    /** Largest number of modules one test file's closure may visit. */
    maxClosureSize?: number;
}

/**
 * Which test files reach the given implementation paths, by following the files' own imports.
 *
 * Deliberately not an AST: the four import forms are syntactically unambiguous enough that a parser would add a
 * dependency and a failure mode (a file the parser cannot parse yields no edges *silently*) without changing the
 * answer. A regex that misses an edge is compensated for by the corroboration rule one level up, where an empty
 * CodeGraph answer is only accepted when this scan agrees with it.
 */
export async function findAffectedTestsByImportGraph(
    root: string,
    sourcePaths: string[],
    limits: ImportGraphLimits = {},
): Promise<ImportGraphResult> {
    const maxFiles = limits.maxFiles ?? 5_000;
    const maxClosureSize = limits.maxClosureSize ?? 2_000;

    const allFiles = await listRepositoryFiles(root);
    if (allFiles.length > maxFiles) {
        throw new Error(
            `Import-graph fallback cannot answer: the repository holds ${allFiles.length} files, above the ${maxFiles}-file bound. `
            + 'Refusing rather than scanning a subset, because a partial graph would be reported as a complete answer.',
        );
    }

    const codeFiles = allFiles.filter((path) => codeExtensions.some((extension) => path.endsWith(extension)));
    const known = new Set(codeFiles);
    const testFiles = codeFiles.filter(isAffectedTestPath);

    // Forward edges, built once: reading every module once is cheaper than re-reading per test file.
    const edges = new Map<string, string[]>();
    for (const path of codeFiles) {
        const source = await readFile(join(root, path), 'utf8').catch(() => null);
        if (source === null) continue;
        edges.set(path, resolveSpecifiers(path, importedSpecifiers(source), known));
    }

    // A queried path is answerable only if the scan actually holds it. A declared path with no file is a fact about the
    // declaration, and this instrument may not report it as "no test reaches it".
    const covered = new Set(sourcePaths.filter((path) => known.has(withoutExtension(path)) || known.has(path)));
    const normalizedSources = sourcePaths.map((path) => (known.has(path) ? path : withoutExtension(path)));
    const importers = new Map<string, string[]>();

    for (const testFile of testFiles) {
        const closure = closureOf(testFile, edges, maxClosureSize);
        if (closure === null) {
            throw new Error(
                `Import-graph fallback cannot answer: the import closure of ${testFile} exceeds ${maxClosureSize} modules. `
                + 'Refusing rather than returning a truncated closure, which would under-report affected tests.',
            );
        }
        for (let index = 0; index < sourcePaths.length; index += 1) {
            const source = normalizedSources[index]!;
            // Extensionless matches work both ways: a test imports './impl.js' while the matrix declares 'src/impl.ts'.
            const reachable = closure.has(source) || closure.has(withoutExtension(source));
            if (!reachable) continue;
            const found = importers.get(sourcePaths[index]!) ?? [];
            if (!found.includes(testFile)) found.push(testFile);
            importers.set(sourcePaths[index]!, found);
        }
    }

    return { importers, covered };
}

function resolveSpecifiers(fromPath: string, specifiers: string[], known: Set<string>): string[] {
    const fromDirectory = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
    const resolved: string[] = [];
    for (const specifier of specifiers) {
        const candidate = join(fromDirectory, specifier).replaceAll('\\', '/');
        for (const suffix of resolutionSuffixes) {
            if (known.has(`${candidate}${suffix}`)) {
                resolved.push(`${candidate}${suffix}`);
                break;
            }
        }
        // `./impl.js` naming a TypeScript source is the normal shape in this repository's ESM output.
        const stem = withoutExtension(candidate);
        if (!resolved.includes(`${candidate}`)) {
            for (const suffix of resolutionSuffixes.slice(1)) {
                if (known.has(`${stem}${suffix}`)) {
                    resolved.push(`${stem}${suffix}`);
                    break;
                }
            }
        }
    }
    return [...new Set(resolved)];
}

/** The modules reachable from `start`, or `null` when the traversal exceeds the bound. */
function closureOf(start: string, edges: Map<string, string[]>, maxSize: number): Set<string> | null {
    const seen = new Set<string>([start]);
    const queue = [start];
    while (queue.length > 0) {
        const current = queue.shift()!;
        for (const next of edges.get(current) ?? []) {
            if (seen.has(next)) continue;
            if (seen.size >= maxSize) return null;
            seen.add(next);
            queue.push(next);
        }
    }
    return seen;
}
