import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { changedGitPaths, changedPathsSinceBranchPoint } from '../core/git.js';
import { declaredContentPaths, isIgnoredRepositoryPath } from '../core/repository-identity.js';

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
    /**
     * Paths **committed** on this branch that the declaration does not cover.
     *
     * The reading `git status` cannot do. The working tree says nothing about work already committed, so a change could
     * commit content outside its declaration and the seal would see a clean tree — measured. The anchor is the branch point
     * (the merge base with the default branch), which is the standard answer to "what has this branch done".
     */
    committedOutsideDeclaration: string[];
    /**
     * Whether that reading was possible at all.
     *
     * `unavailable` is not `available` with an empty list: no default branch to compare against means nothing was
     * established, and a caller that reports a pass there would be reporting a reading it never took.
     */
    committedReading: 'available' | 'unavailable';
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
    /**
     * The paths the previous revision hashed, when the caller has them.
     *
     * **What this second reading can and cannot see, measured.** `git status` reports uncommitted work only, so an
     * independent reading asked whether "already committed" was covered — it is not, and it cannot be from here: the
     * digests a revision records are the paths it *hashed*, which is the declared surface itself (measured on this
     * change's own revisions: `pathDigests` keys are set-equal to `ownedPaths`, 61/61). So a digest key that the
     * declaration does not cover means exactly one thing — **the declaration lost a path it used to carry** — and that is
     * the fact this reading reports: a shrinking declaration, named by path, which is how a change escapes the surface its
     * risk classes are derived from.
     *
     * A committed change *outside* the declaration is therefore not caught here, and claiming otherwise was a defect in
     * this change's own prose rather than in this check. What closes that gap is the working-tree reading on the next
     * seal, and a revision delta; both are recorded as follow-ups rather than implied by this parameter.
     */
    previousPathDigests?: readonly string[];
    /**
     * An ISO timestamp to anchor the committed reading at, when the caller has one.
     *
     * **The narrow anchor, and the right one for a task.** Without it the reading starts at the branch point and therefore
     * includes everything the branch ever committed — including another change's work on a shared branch, which is not this
     * change's undeclared content and must not refuse its seal. A task knows when it was opened, so the caller passes that and
     * the reading becomes "what this change committed".
     */
    sinceCommitted?: string;
}): Promise<UndeclaredChanges> {
    // Normalized the same way on both sides: the declaration may be written with a leading `./` or with backslashes, and
    // git reports repository-relative paths with forward slashes. Comparing the raw strings would report a declared path
    // as undeclared, which is the direction that blocks legitimate work.
    const normalize = (path: string): string => path.replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
    const declared = [...new Set(input.declaredPaths.map(normalize).filter(Boolean))].sort();
    const declaredSet = new Set(declared);
    // A path is covered when it is declared, when the declaration's own walk covers it, or when it sits inside a declared
    // directory. A declaration of `src/quality` covers `src/quality/x.ts`; a declaration of `src/quality/x.ts` covers
    // nothing but itself.
    //
    // **"Is this a directory" is asked of the filesystem, never of the spelling.** The rule was
    // `!path.includes('.') || path.endsWith('/**')`, so a *dotted directory* — `.agents/skills`, `.github/workflows`,
    // `src/v1.0` — read as a file: every path under it then read as undeclared and the seal refused content the declaration
    // already named, which is the same defect the tier resolver had (the spelling deciding the gate); the opposite arm read
    // a dotless *file* (`LICENSE`, `Makefile`) as a directory prefix. Measured by an independent round (R6-F2), and latent
    // because this repository has never declared a directory: 0 of 881 recorded `ownedPaths` entries name one, so the
    // route in is `scope change --add <dir>`.
    const covered = declared.length === 0 ? undefined : await declaredContentPaths(input.root, declared);
    const coveredSet = new Set(covered?.paths ?? []);
    const directoryPrefixes: string[] = [];
    for (const declaration of declared) {
        try {
            if ((await stat(join(input.root, declaration))).isDirectory()) directoryPrefixes.push(declaration);
        } catch {
            // Gone from the working tree. A deletion still needs its files to read as covered, and what it *was* is recorded:
            // the previous revision's hashed paths answer it from data rather than from a guess about the name.
            const carried = (input.previousPathDigests ?? [])
                .map(normalize)
                .some((previous) => previous.startsWith(`${declaration}/`));
            if (carried) directoryPrefixes.push(declaration);
        }
    }
    const isCovered = (path: string): boolean => {
        const candidate = normalize(path);
        return declaredSet.has(candidate)
            || coveredSet.has(candidate)
            || directoryPrefixes.some((prefix) => candidate === prefix || candidate.startsWith(`${prefix}/`));
    };
    // What git reports, plus what the previous revision hashed, plus what this branch committed — the second reports a
    // declaration that lost a path it used to carry, and the third closes the gap `git status` cannot see.
    const committed = changedPathsSinceBranchPoint(input.root, input.sinceCommitted === undefined ? {} : { since: input.sinceCommitted });
    const candidates = [...changedGitPaths(input.root), ...(input.previousPathDigests ?? [])];
    const uncovered = (paths: readonly string[]): string[] => [...new Set(paths
        .map(normalize)
        .filter((path) => path.length > 0)
        .filter((path) => !isExcluded(path))
        .filter((path) => !isCovered(path)))].sort();

    return {
        paths: uncovered(candidates),
        declared,
        // **Named apart from `paths`.** A caller deciding "is this worked tree inside its declaration" wants the working-tree
        // answer; a caller auditing the branch's whole work wants this one too, and folding them together would relabel the
        // working-tree reading as something it is not.
        committedOutsideDeclaration: uncovered(committed ?? []),
        committedReading: committed === null ? 'unavailable' : 'available',
    };
}
