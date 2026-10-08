import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { runProcess } from '../process/run.js';
import { hashContent } from '../core/hash.js';
import type { VerifyContext } from '../producers/port.js';
import type { Subject, VerdictProducer } from '../kernel/types.js';

/**
 * The verify context: where a command actually runs, and what it is allowed to touch.
 *
 * **Three properties that were missing, each measured.**
 *
 * 1. **The wall clock is enforced, not recorded.** The old runner passed a hard-coded 600 s, so `Policy.budgets.
 *    maxWallMs` (the tier's envelope, and the number a ledger's `budget_exhausted` comes from) bounded nothing; a
 *    verifier could run far past the envelope the decision then judged it against.
 * 2. **A mutation cannot leave the repository.** Paths went through `resolve(root, path)`, which resolves `..` and
 *    absolute paths happily, so a crafted evidence item could read or overwrite anything the user can — and the
 *    restore step would then write the original content back to that outside path. Containment is checked before any
 *    read or write.
 * 3. **The producing run has an identity.** `producer()` names the run and the actor, which is what lets
 *    `groupByProducer` tell two independent readings from one reading counted twice, and lets `decide` refuse an
 *    approval asked for by a party that produced the evidence.
 *
 * It lives here rather than in the CLI because a **second** caller arrived: `ledger replay` re-runs recorded evidence
 * through the same verifier to measure whether the verdicts still reproduce, and a second copy of containment and of the
 * wall-clock rule is exactly the defect this repository removes most often — the envelope would then have two
 * derivations, and only one of them would be enforced.
 */
export function containedPath(root: string, relativePath: string): string | null {
    const lexical = containedLexicalPath(root, relativePath);
    if (!lexical) return null;
    // **Resolved, not just spelled.** A lexical fence accepts `tmp/link/req.json` while `tmp/link` is a symlink to
    // a directory outside the workspace, so the write (or the read) leaves the repository without the path ever
    // looking like it does. The real location decides; a path that does not exist yet is resolved through its
    // nearest existing ancestor, which is the directory the write will actually land in.
    return realContainedPath(root, lexical) ? lexical : null;
}

/** The lexical half of containment, kept separate so the realpath check can reuse the same spelling rules. */
function containedLexicalPath(root: string, relativePath: string): string | null {
    if (relativePath.trim() === '' || isAbsolute(relativePath)) return null;
    const absolute = resolve(root, relativePath);
    const inside = relative(root, absolute).replaceAll('\\', '/');
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return null;
    return absolute;
}

/**
 * Whether an already-resolved path is really inside the workspace, following symlinks.
 *
 * A path that does not exist resolves through its nearest existing ancestor: `tmp/new.json` is judged by where `tmp`
 * really is, which is the fact a lexical fence cannot see. A component that is a symlink is resolved too, and the
 * destination decides — except when the link is dangling, where there is nothing to resolve and the spelling is refused.
 */
function realContainedPath(root: string, absolute: string): boolean {
    // **The fence answers "where does this land", not "is there a link".** Two defects came from answering the second
    // question instead: refusing every symlink component also refused links whose target is inside the workspace (so
    // reads failed silently and the mutation-restore write threw), and comparing an unresolved `probe` against a resolved
    // root refused every existing path whenever the workspace root itself contained a symlinked component (a symlinked
    // `$HOME`, macOS `/var → /private/var`) while accepting paths that did not exist yet — the verdict depended on whether
    // the file was already there. Both are answered by resolving each segment and comparing like with like.
    const realRoot = realpathSync(root);
    const segments = relative(root, absolute).replaceAll('\\', '/').split('/').filter((entry) => entry !== '');
    let probe = realRoot;
    for (const [index, segment] of segments.entries()) {
        const next = resolve(probe, segment);
        const last = index === segments.length - 1;
        let stats;
        try {
            stats = lstatSync(next);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
            // Absent from here down: the rest cannot exist, so the write lands in `probe`, which was resolved above.
            // A path that does not exist cannot leave the workspace.
            return true;
        }
        if (stats.isSymbolicLink()) {
            let target: string;
            try {
                target = realpathSync(next);
            } catch {
                // **A dangling link is judged by its target, not by its spelling.** R5-5: this refused every dangling link,
                // including one whose target is a *relative* path inside the workspace — `ln -s not-yet.json a.json` — which
                // `writeFile` would create in bounds. The target is readable from the link itself (`readlink`), so it can be
                // resolved against the link's own directory and judged; only a target that still cannot be located is
                // refused, because then nothing can prove where the write lands.
                let raw: string;
                try {
                    raw = readlinkSync(next);
                } catch {
                    return false;
                }
                const literal = isAbsolute(raw) ? raw : resolve(dirname(next), raw);
                if (!insideWorkspace(realRoot, literal) && !insideWorkspace(realRoot, dirname(literal))) {
                    return false;
                }
                // The remainder of the path is appended to the link's target, exactly as the OS would, and judged there.
                probe = dirname(literal);
                if (!insideWorkspace(realRoot, probe)) return false;
                continue;
            }
            // Resolved: the link is followed, and the destination decides. A link out of the workspace is refused here.
            if (!insideWorkspace(realRoot, target)) return false;
            probe = target;
            continue;
        }
        if (!last && !stats.isDirectory()) return false;
        probe = next;
    }
    return insideWorkspace(realRoot, probe);
}

/**
 * One spelling of the comparison, so a resolved location and the resolved root are always measured the same way.
 *
 * **The root itself is inside the root.** `relative(realRoot, realRoot)` is the empty string, and reading emptiness as
 * "outside" refused a link whose resolved target is the workspace root — a position that resolves perfectly, refused on
 * the grounds of spelling, which is the opposite of what §12.1 says the fence does. Only a path that escapes upwards or
 * becomes absolute is outside.
 */
function insideWorkspace(realRoot: string, resolved: string): boolean {
    const inside = relative(realRoot, resolved).replaceAll('\\', '/');
    return (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside)));
}

/**
 * A cross-process critical section keyed on the file a check is about to mutate.
 *
 * **The verification cycle is not re-entrant on one file.** It reads the original, injects the defect, runs the check and
 * writes the original back — so two overlapping runs on the same file interleave exactly as one would fear: the second
 * reads the first's *injected* content as its original and writes that back, leaving a defect in the checkout with only a
 * verdict as the signal (measured by an independent round: `git diff` non-empty after two concurrent reads of the same
 * check, and the next run reporting `refuted … the check was already failing before any mutation`).
 *
 * The lock is per file, not global: two checks that touch different files still overlap, and the two that touch the same
 * one cannot. It is a directory lock (`mkdir` is atomic), so it holds across processes and not only across promises.
 */
/**
 * **The tree is not as it was found, and that is not a verdict.** A check that could not run is `inconclusive`; a checkout
 * that still holds the injected defect is a broken repository, and an operator reading a verdict has no reason to look at
 * the tree. This error is thrown past the verifiers so the run fails loudly.
 */
export class UnrestoredMutation extends Error {}

/**
 * **A verification is holding this file mutated right now, so a reading taken here is not evidence.**
 *
 * The exclusive window is what stops two cycles from interleaving; this error is what a run is told when it cannot get one.
 * It exists so that fact is never converted into a verdict: a run that read a tree another cycle had injected would report
 * `refuted … the check was already failing before any mutation` — a statement about the *check* derived from a tree it does
 * not own, which is the misdiagnosis this whole mechanism exists to remove.
 */
export class VerificationWindowLive extends Error {}

/**
 * **The path's identity, and the file's identity — two keys, because they answer two different questions.**
 *
 * An independent round measured three holes in this mechanism in a row, and each one was the same mistake in a new place:
 * a lock key that is not the thing it is supposed to name.
 *
 * 1. `a.ts` and `./a.ts` took two locks — the key was a *spelling*. Fixed by resolving the path.
 * 2. Two hard links to one inode took two locks — the key was a *name* for a file that has several. Fixed by keying on
 *    `dev`+`ino`.
 * 3. And then: a check that replaces its own target — an ordinary `mv`, which the comment in `producers/verifiers.ts` calls
 *    how a formatter lands its result — moves the inode **inside** the window, and the key was derived *before* the window
 *    was held. A second cycle therefore derived a different key, took a different lock, and ran concurrently: it found the
 *    first cycle's journal by file name, restored the first cycle's original mid-flight, and the first cycle reported
 *    `refuted … the check did not redden under its own defect` about a perfectly sensitive check.
 *
 * Neither key alone is enough, and that is not a compromise — they name two facts that both have to hold:
 *
 * - `pathKey` (the resolved path) is what the cycle **mutates and restores**. It is stable for the whole window even when
 *   the inode moves, and it is the key the *lock* is taken on first.
 * - `identityKey` (`dev`+`ino`, derived **inside** that lock) is what collapses every other name that reaches the same
 *   physical file — a hard link, a symlinked directory — so mutating one of them cannot go unnoticed by the other.
 *
 * The lock order is what makes the pair deadlock-free: the path lock is always taken first and each cycle holds exactly one
 * path lock and waits for at most one identity lock, so there is no cycle in the wait-for graph.
 */
function pathKeyFor(root: string, relativePath: string): string {
    const absolute = resolve(root, relativePath);
    try {
        return hashContent(realpathSync(absolute)).slice(0, 16);
    } catch {
        // The file may not exist yet; the resolved path is the best identity available.
        return hashContent(absolute).slice(0, 16);
    }
}

/** The file's identity at the moment it is asked for: `dev`+`ino`, or `null` when there is no file to identify. */
function identityKeyFor(root: string, relativePath: string): string | null {
    try {
        const stat = statSync(realpathSync(resolve(root, relativePath)));
        return hashContent(`${stat.dev}\u0000${stat.ino}`).slice(0, 16);
    } catch {
        return null;
    }
}

/** Whether the process that took a lock is still there. `EPERM` means it exists and is not ours. */
function holderAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

/**
 * **The window a verification cycle runs in, and the two identities it was opened under.**
 *
 * Both keys are derived **once** and carried in this object through every step of the cycle: the journal write, the repair
 * the next entry performs, and the clear. They used to be recomputed at each of those three sites from the file as it stood
 * *then*, so a check that replaces its target atomically — an ordinary `mv` — moved the inode inside the window and the
 * clear then looked for a journal under a name nobody had written. Measured by an independent round: a killed run's defect
 * was never repaired (its journal was an orphan) and every successful cycle left a stale journal while reporting success.
 *
 * The journal is named by the **path** key, which is the one identity a check cannot invalidate by replacing its own target
 * — so a note is findable by name alone, and a note whose bytes nobody can read is still attributable to the file it is
 * about and can be quarantined rather than leaking forever.
 */
export interface VerificationWindow {
    readonly root: string;
    readonly file: string;
    /** The resolved path's identity: what the cycle mutates and restores, and what names its journal. */
    readonly pathKey: string;
    /** The physical file's identity, derived inside the path lock; `null` when there was no file to identify. */
    readonly identityKey: string | null;
}

const locksDirFor = (root: string): string => join(root, '.kata', 'locks');
const pathLockDirFor = (root: string, pathKey: string): string => join(locksDirFor(root), `verify-path-${pathKey}.lock`);
const identityLockDirFor = (root: string, identityKey: string): string => join(locksDirFor(root), `verify-id-${identityKey}.lock`);
const journalFor = (root: string, pathKey: string): string => join(locksDirFor(root), `verify-${pathKey}.journal.json`);
/**
 * Every note a cycle may have left for this file, found **by name first and by the path it names second**.
 *
 * The name carries the path key, which is the one identity a check cannot invalidate by replacing its own target — so a
 * note is findable by name alone. The second test (`note.file === relativePath`) is what makes a note written under another
 * spelling of the same file, or by an older scheme, still reachable: it costs one read and closes a case the name alone
 * would miss. An unreadable note is returned too, because "cannot be attributed" and "cannot be read" are different facts
 * and only the first would justify ignoring it — and ignoring it is how a note leaks forever.
 */
async function journalPathsFor(root: string, relativePath: string, pathKey: string): Promise<string[]> {
    let names: string[];
    try {
        names = await readdir(locksDirFor(root));
    } catch {
        return [];
    }
    const byName = `verify-${pathKey}.journal.json`;
    const found: string[] = [];
    for (const name of names.filter((entry) => entry.endsWith('.journal.json'))) {
        const path = join(locksDirFor(root), name);
        if (name === byName) {
            found.push(path);
            continue;
        }
        const note = await readFile(path, 'utf8').then((text) => JSON.parse(text) as { file?: unknown }).catch(() => null);
        if (note?.file === relativePath) found.push(path);
    }
    return found;
}

/**
 * **A killed run's defect is repaired by the next run, whatever happened to the inode.**
 *
 * The repair is contained (an uncontained path wrote outside the workspace) and applies only where the injected bytes are
 * still present (a stale journal overwrote good content) — both measured by an independent round, and both kept.
 *
 * A note that **nobody can read** is quarantined by removal rather than blocking the file forever. That sentence was false
 * when an independent round read it: the discovery above dropped an unparseable note before this loop could remove it, so it
 * leaked and was re-parsed on every window entry. It is true now because the note's *name* carries the path key, so a note
 * that cannot be parsed can still be attributed to the file it is about.
 */
async function repairFromJournals(root: string, relativePath: string, pathKey: string): Promise<void> {
    for (const path of await journalPathsFor(root, relativePath, pathKey)) {
        const note = await readFile(path, 'utf8').then((text) => JSON.parse(text) as { original?: unknown; injectedHash?: unknown }).catch(() => null);
        if (note !== null && typeof note.original === 'string') {
            let target: string | null = null;
            try {
                target = containedPath(root, relativePath);
            } catch {
                target = null;
            }
            if (target !== null) {
                const current = await readFile(target, 'utf8').catch(() => null);
                const stillInjected = current !== null
                    && (typeof note.injectedHash !== 'string' || hashContent(current) === note.injectedHash);
                if (stillInjected) await writeFile(target, note.original);
            }
        }
        await rm(path, { force: true });
    }
}

/**
 * **The whole verification cycle runs in one exclusive window.**
 *
 * Two properties, and they are the two halves of AC-1:
 *
 * 1. **Exclusive.** Nothing else runs a step of a cycle on this file while this one is inside — including this cycle's own
 *    opening and closing checks, which used to run *outside* the lock. Measured by an independent round: a closing check
 *    taken outside the window landed inside another cycle's injection and downgraded a valid evidence item to
 *    `inconclusive … the tree was not restored to green` while the checkout was byte-identical to clean.
 * 2. **Honest to observers.** A run that cannot get the window is told so by name (`VerificationWindowLive`) instead of
 *    being handed a verdict about a tree it does not own. The caller must propagate it; converting it into a verdict is the
 *    same misdiagnosis wearing the mechanism's clothes.
 *
 * The lock is a directory (`mkdir` is atomic), so it holds across processes and not only across promises, and a lock is
 * reclaimed only when its holder is gone — reclaiming on the mere presence of a journal stole live locks and let the two
 * runs interleave (measured: `peak=2`).
 */
export async function withVerificationWindow<T>(
    root: string,
    relativePath: string,
    action: (window: VerificationWindow) => Promise<T>,
    options?: { deadlineMs?: number },
): Promise<T> {
    await mkdir(locksDirFor(root), { recursive: true });
    const deadline = Date.now() + (options?.deadlineMs ?? 60_000);

    // **The path lock comes first, and it is the one the cycle's own life depends on.** It is keyed on the resolved path,
    // which a check cannot change by replacing its target — so no second cycle can slip past it while this one is inside,
    // however the file's inode moves underneath.
    const pathKey = pathKeyFor(root, relativePath);
    const pathLockDir = pathLockDirFor(root, pathKey);
    await acquireLock(pathLockDir, relativePath, deadline);

    let identityLockDir: string | null = null;
    try {
        // **The identity is derived here, inside the path lock — not before it.** That ordering is the whole of the third
        // hole an independent round found: deriving it at the window's entry meant the key was taken while the file could
        // still be somebody else's to change, and a check that lands its result with `mv` moved the inode between the
        // derivation and the acquisition, so the next cycle derived a *different* key and took a lock nobody held.
        const identityKey = identityKeyFor(root, relativePath);
        if (identityKey !== null) {
            identityLockDir = identityLockDirFor(root, identityKey);
            // The alias lock: every other name that reaches this same physical file — a hard link, a path through a
            // symlinked directory — derives this key too, so mutating one of them cannot go unnoticed by the other.
            await acquireLock(identityLockDir, relativePath, deadline);
        }
        const window: VerificationWindow = { root, file: relativePath, pathKey, identityKey };
        try {
            // The repair runs inside both locks: a note from a killed run is restored before this cycle reads anything.
            await repairFromJournals(root, relativePath, pathKey);
            return await action(window);
        } finally {
            if (identityLockDir !== null) await rm(identityLockDir, { recursive: true, force: true });
        }
    } finally {
        await rm(pathLockDir, { recursive: true, force: true });
    }
}

/**
 * Take one directory lock, waiting for a live holder and reclaiming a dead one.
 *
 * `mkdir` is atomic, so this holds across processes and not only across promises. A lock is reclaimed **only when its
 * holder is gone**: reclaiming on the mere presence of a journal stole live locks — a healthy cycle has a journal for its
 * whole window — and the two runs then interleaved (measured: `peak=2`). Liveness is the question, so liveness is what is
 * asked. Waiting past the deadline is refused by name rather than converted into a verdict.
 */
async function acquireLock(lockDir: string, relativePath: string, deadline: number): Promise<void> {
    for (;;) {
        try {
            await mkdir(lockDir);
            await writeFile(join(lockDir, 'holder.json'), JSON.stringify({ pid: process.pid, file: relativePath, startedAt: new Date().toISOString() }));
            return;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            const holder = await readFile(join(lockDir, 'holder.json'), 'utf8').then((text) => JSON.parse(text) as { pid?: number }).catch(() => null);
            const dead = holder?.pid === undefined ? false : !holderAlive(holder.pid);
            if (dead) {
                await rm(lockDir, { recursive: true, force: true });
                continue;
            }
            if (Date.now() > deadline) {
                // **Told, not handed a verdict.** This is the fact an observer needs: a verification holds this file mutated
                // right now, so nothing measured now describes the artifact.
                throw new VerificationWindowLive(
                    `a verification window is live on ${relativePath}: another run holds it past this run's deadline, so nothing measured now is evidence about the artifact`,
                );
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }
}

/**
 * Record what is about to be mutated, so a run that dies mid-cycle can be repaired by the next one.
 *
 * The journal carries the injected content's digest as well as the original, so recovery applies only to a file that still
 * holds what this run wrote — a stale journal cannot overwrite good content.
 */
export async function recordMutation(window: VerificationWindow, original: string, injected: string): Promise<void> {
    await mkdir(locksDirFor(window.root), { recursive: true });
    await writeFile(
        // Named by the **path** key: the one identity a check cannot invalidate by replacing its own target, so the note this
        // cycle writes and the note this cycle clears are the same file even when the inode moves mid-window.
        journalFor(window.root, window.pathKey),
        JSON.stringify({ file: window.file, original, injectedHash: hashContent(injected) }),
    );
}

/** The injection is over: there is nothing left to repair. */
export async function clearMutation(window: VerificationWindow): Promise<void> {
    await rm(journalFor(window.root, window.pathKey), { force: true });
}

export function buildContext(
    root: string,
    subject: Subject,
    options: { timeoutMs: number; producer: VerdictProducer; onRefusal?: (what: string) => void; now?: () => string; windowDeadlineMs?: number },
): VerifyContext {
    const now = options.now ?? (() => new Date().toISOString());
    return {
        root,
        subject,
        run: async (command: string) => {
            const result = await runProcess('sh', ['-c', command], {
                cwd: root,
                // The tier's own envelope, passed through rather than a second hard-coded number: two limits for one
                // fact is how a ledger came to report `budget_exhausted` against a bound nothing enforced.
                timeoutMs: options.timeoutMs,
                maxCaptureBytes: 200_000,
            });
            return { code: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.exitCode === 124 };
        },
        readText: async (relativePath: string) => {
            const absolute = containedPath(root, relativePath);
            if (absolute === null) {
                options.onRefusal?.(`${relativePath} is outside the workspace root`);
                return null;
            }
            try {
                return await readFile(absolute, 'utf8');
            } catch {
                return null;
            }
        },
        exists: async (relativePath: string) => {
            const absolute = containedPath(root, relativePath);
            if (absolute === null) return false;
            try {
                await readFile(absolute);
                return true;
            } catch {
                return false;
            }
        },
        writeText: async (relativePath: string, content: string) => {
            const absolute = containedPath(root, relativePath);
            if (absolute === null) {
                // Loud, because this one is the mutation restore path: silently declining to write would leave the
                // injected defect in place, and a mutation that is not restored is a repository left broken.
                throw new Error(`refusing to write ${relativePath}: it is outside the workspace root`);
            }
            await writeFile(absolute, content, 'utf8');
        },
        now,
        producer: () => options.producer,
        ...(options.windowDeadlineMs === undefined ? {} : { windowDeadlineMs: options.windowDeadlineMs }),
    };
}
