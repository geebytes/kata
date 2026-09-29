import { changedGitPaths } from '../core/git.js';
import { isIgnoredRepositoryPath } from '../core/repository-identity.js';

/**
 * **The difference between what changed and what was declared — before the seal freezes anything.**
 *
 * The seal's confidence surface is `ownedPaths`: it walks those paths, digests them, and calls the result the revision.
 * `verify` reads the working tree instead. Nothing owned the difference between the two, and the failure mode is not a
 * wrong answer but an *undecidable* one: a behaviour change outside the declaration produced a `workspaceDrift` line
 * inside a twenty-field diagnostics object, and the re-seal that followed refused with "the declared manifest is
 * unchanged" — which was true, because the declaration really had not changed. Each stage believed the other owned it.
 *
 * **This reads the existing derivation rather than parsing `git status` again.** `changedGitPaths` already handles the
 * three traps this would otherwise repeat: the two status characters, a rename's second name, and untracked directories
 * (`-z` with `--untracked-files=all`). Writing a second parser here is the defect this repository removes everywhere
 * else, and the incident's own diagnosis produced one false positive by slicing the porcelain line one character short.
 */
export interface UndeclaredChanges {
    /** Repository-relative paths that changed and are neither declared nor excluded, sorted. */
    paths: string[];
    /** The declared surface, normalized, so a caller can report what it compared against. */
    declared: string[];
}

/**
 * Paths the seal is not about.
 *
 * `.kata/**` is the governance record — excluded from the owned digest by design (a change that commits its own records
 * must not thereby supersede its own revision), and it is the store every Kata command writes while it runs. `tmp/**` is
 * this project's declared scratch space for evidence and working files. Everything `isIgnoredRepositoryPath` already
 * names is excluded for the same reason: the repository has decided it is not source.
 */
function isExcluded(path: string): boolean {
    // **Named rather than left to the repository's ignore file.** Both of these are Kata's own by definition: `.kata/`
    // is the governance store (excluded from the owned digest on purpose, and written by every command while it runs)
    // and `tmp/` is the scratch space this project's rules put evidence and working files in. Deriving the exclusion
    // from `.gitignore` alone would make the check's correctness depend on which repository it runs in — measured: a
    // fixture repository with no ignore file reported the task store it had just written as an undeclared change.
    const segments = path.split('/');
    if (segments[0] === '.kata' || segments[0] === 'tmp') return true;
    return isIgnoredRepositoryPath(path);
}

/**
 * The changed paths that the declaration does not cover.
 *
 * Returns a value rather than throwing, because the caller decides: the seal refuses, and a report command prints.
 */
export async function undeclaredChanges(input: {
    root: string;
    declaredPaths: readonly string[];
}): Promise<UndeclaredChanges> {
    // Normalized the same way on both sides: the declaration may be written with a leading `./` or with backslashes, and
    // git reports repository-relative paths with forward slashes. Comparing the raw strings would report a declared path
    // as undeclared, which is the direction that blocks legitimate work.
    const normalize = (path: string): string => path.replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
    const declared = [...new Set(input.declaredPaths.map(normalize).filter(Boolean))].sort();
    const declaredSet = new Set(declared);
    // A path is covered when it is declared, or when it sits inside a declared directory. A declaration of `src/quality`
    // covers `src/quality/x.ts`; a declaration of `src/quality/x.ts` covers nothing but itself.
    const directoryPrefixes = declared.filter((path) => !path.includes('.') || path.endsWith('/**')).map((path) => path.replace(/\/\*\*$/, ''));
    const isCovered = (path: string): boolean => declaredSet.has(path) || directoryPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

    const paths = changedGitPaths(input.root)
        .map(normalize)
        .filter((path) => path.length > 0)
        .filter((path) => !isExcluded(path))
        .filter((path) => !isCovered(path));

    return { paths: [...new Set(paths)].sort(), declared };
}
