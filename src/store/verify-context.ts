import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
 * **No key at all: one verification cycle at a time, per repository.**
 *
 * This mechanism has now had three keys, and an independent round found a hole in each one. That pattern is the finding:
 *
 * 1. The key was the **spelling** of the path, so `a.ts` and `./a.ts` took two locks (measured).
 * 2. The key was the **inode**, so two hard links to one file took two locks (measured), and deriving it *before* the lock
 *    let a check that lands its result with `mv` move the inode between the derivation and the acquisition (measured — the
 *    second cycle then restored the first cycle's original mid-flight and the first reported `refuted … the check did not
 *    redden under its own defect`).
 * 3. The key was the **resolved path**, which `realpathSync` follows through symlinks — so a check that replaces its own
 *    target with a symlink changed the key, the second cycle entered, and — worse, and with no concurrency involved at all —
 *    a single cycle's *restore* write followed the link and overwrote a file the cycle does not own while reporting
 *    `supported` (measured).
 *
 * Every one of those keys was an attempt to name "the same file" by something a check can change: a spelling, an inode, a
 * link target. The instrument was wrong, not its calibration. **A verification mutates the checkout, so a verification is
 * the unit of exclusion** — the repository is what the cycle disturbs, and the repository is the one name that nothing
 * inside the cycle can move.
 *
 * The cost is that two cycles on *different* files no longer run concurrently. That is a property nothing asks for:
 * `verifyAll` runs its items sequentially inside one run, so the only concurrency here was between two CLI invocations, and
 * the price of getting it wrong is a clobbered file with a `supported` verdict beside it.
 *
 * The journal is named by the **relative path**, which is stable for the whole window and cannot be invalidated by anything
 * a check does to the file — so a note is findable by name alone, and a note whose bytes nobody can read is still
 * attributable to the file it is about.
 */
export function verificationLockDir(root: string): string {
    return join(locksDirFor(root), 'verify-repository.lock');
}


/**
 * **Whether this path is still a plain file, or whether something replaced it with a link.**
 *
 * The restore write goes through the path, and `writeFile` follows symlinks: a check that swaps its target for a link to
 * another file makes the restore land in *that* file. Measured by an independent round: a cycle on `a.ts` reported
 * `supported` while `b.ts` — a file it never named — was overwritten with the cycle's original content and `a.ts` was left
 * as a symlink. A cycle may replace its own target with another regular file (an ordinary `mv`); it may not turn it into a
 * door into somebody else's.
 */
/**
 * **The one rule for "may this write land here", stated once and used by every door.**
 *
 * Two rounds found the same defect twice because it was written twice: the restore refused a target that was not a regular
 * file while the killed run's **repair** checked only the final component, so a note could still land in `other/a.ts` through a
 * symlinked parent or in `b.ts` through a hard link (measured). A rule that lives at one door is a rule the other door does
 * not have, so it lives here and both callers use it.
 *
 * The rule is about **the path and the file it reaches**, never about an identity the cycle derived earlier. An earlier
 * version compared `dev`+`ino` before and after the mutation and refused on any change — which refused the ordinary case an
 * independent round then measured: a check that lands its result with `mv` (a formatter) changes the inode, so the restore
 * refused, the injected defect stayed on disk, and an honest check failed the whole run. A rule that breaks honest evidence is
 * worse than the hole it closes.
 *
 * What is refused, and why each one is a way for the bytes to land somewhere the run never named:
 *
 * - **a component of the path is a symbolic link** — the write follows it, so it lands wherever the link points (measured
 *   with a swapped parent directory);
 * - **the target is not a regular file** — a device, a directory, a socket, or a link at the final component;
 * - **the target has more than one name** (`nlink > 1`) — a hard link shares the inode, so writing through one name rewrites
 *   the other (measured: `b.ts` held the cycle's original content after a check hard-linked it over `a.ts`).
 *
 * What is allowed: an in-place write, an atomic replace, a delete-and-recreate, a truncate, a `chmod` — every ordinary way a
 * check lands its own result at the path it was told to mutate. All of them leave the path pointing at one file with one name.
 */
export type WriteTarget = { ok: true } | { ok: false; why: string };

export function writeTargetFor(root: string, relativePath: string): WriteTarget {
    const absolute = resolve(root, relativePath);
    const rootAbsolute = resolve(root);
    // Every component between the root and the file, then the file itself: a link anywhere in the chain redirects the write.
    const parts = relative(rootAbsolute, absolute).split(/[\\/]+/).filter((part) => part !== '' && part !== '.');
    let walked = rootAbsolute;
    for (const part of parts) {
        walked = join(walked, part);
        let stat;
        try {
            stat = lstatSync(walked);
        } catch {
            // The file the cycle mutated is gone (a check may delete and recreate it only as the last step, and the restore
            // has not run yet): there is nothing to write into, so this is a refusal rather than a silent no-op.
            return { ok: false, why: `${relativePath} does not exist (nothing at ${relative(rootAbsolute, walked)})` };
        }
        if (stat.isSymbolicLink()) {
            return { ok: false, why: `${relative(rootAbsolute, walked)} is a symbolic link, so a write through ${relativePath} would land wherever it points` };
        }
        if (walked === absolute) {
            if (!stat.isFile()) return { ok: false, why: `${relativePath} is not a regular file` };
            if (stat.nlink > 1) return { ok: false, why: `${relativePath} has ${stat.nlink} names (it is hard-linked), so a write through it would rewrite the other name` };
        } else if (!stat.isDirectory()) {
            return { ok: false, why: `${relative(rootAbsolute, walked)} is in the middle of the path and is not a directory` };
        }
    }
    return { ok: true };
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
    /** The file this cycle mutates and restores. It names the journal; it is not part of the lock's identity. */
    readonly file: string;
}

/**
 * **The window's own state lives outside the tree the check may write.**
 *
 * The lock and the journal used to sit at `<root>/.kata/locks`, which is inside the tree the verified command runs in and may
 * edit. An independent round measured the consequence: a check that removed that directory made the next cycle's `mkdir`
 * succeed, so two cycles ran at once (`peak=2`), both reported `supported`, and the injected defect stayed on disk — and a
 * variant made the second cycle report a false `refuted … did not redden under its own defect`. A mechanism that keeps its
 * exclusion inside the directory it is excluding cannot exclude anything; the directory is keyed on the repository's real
 * path so two checkouts do not share a window, and it is not a path a check has any reason to name.
 */
const locksDirFor = (root: string): string => join(tmpdir(), 'kata-verify-locks', hashContent(realpathOf(root)).slice(0, 16));

/** Where this repository's window state lives. Exported so a guard can look at the real directory instead of guessing it. */
export const verificationLocksDir = (root: string): string => locksDirFor(root);

/** The repository's real path, or its resolved path when it does not exist yet. */
function realpathOf(root: string): string {
    try {
        return realpathSync(root);
    } catch {
        return resolve(root);
    }
}
/** The journal's name, derived from the file the cycle is about — stable for the whole window by construction. */
const journalNameFor = (relativePath: string): string => `verify-${hashContent(relativePath).slice(0, 16)}.journal.json`;
const journalFor = (root: string, relativePath: string): string => join(locksDirFor(root), journalNameFor(relativePath));
/**
 * Every note a cycle may have left for this file, found **by the name the file's path derives**.
 *
 * The name cannot be invalidated by anything a check does to the file — no inode move, no symlink swap — so a note is
 * findable by name alone. The `file` field is checked as a second opinion, because a note written by an older scheme (or by
 * hand) should still be reachable; an unparseable note is returned too, since its *name* is what attributes it and
 * "cannot be parsed" is not "cannot be attributed" — ignoring it is how it leaks forever.
 */
async function journalPathsFor(root: string, relativePath: string): Promise<string[]> {
    let names: string[];
    try {
        names = await readdir(locksDirFor(root));
    } catch {
        return [];
    }
    const byName = journalNameFor(relativePath);
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
async function repairFromJournals(root: string, relativePath: string): Promise<void> {
    for (const path of await journalPathsFor(root, relativePath)) {
        const note = await readFile(path, 'utf8').then((text) => JSON.parse(text) as { original?: unknown; injectedHash?: unknown }).catch(() => null);
        if (note !== null && typeof note.original === 'string') {
            // **The repair asks the same question the restore asks, through the same rule.** It used to test only the final
            // component, so a killed run's note still landed in `other/a.ts` through a symlinked parent and in `b.ts` through
            // a hard link — the defect the restore had just been fixed for, alive at the other door. Both call
            // `writeTargetFor`; there is no second copy of the rule to fall behind.
            const target = writeTargetFor(root, relativePath);
            if (target.ok) {
                const absolute = containedPath(root, relativePath);
                if (absolute !== null) {
                    const current = await readFile(absolute, 'utf8').catch(() => null);
                    const stillInjected = current !== null
                        && (typeof note.injectedHash !== 'string' || hashContent(current) === note.injectedHash);
                    if (stillInjected) await writeFile(absolute, note.original);
                }
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
    // One lock, named by the repository. There is no key to derive, so there is nothing a check can do to a file that
    // changes which lock its own cycle holds — and no alias that reaches the same file by a second name.
    const lockDir = verificationLockDir(root);
    await acquireLock(lockDir, relativePath, deadline);
    try {
        // The repair runs inside the lock: a note from a killed run is restored before this cycle reads anything.
        await repairFromJournals(root, relativePath);
        return await action({ root, file: relativePath });
    } finally {
        await rm(lockDir, { recursive: true, force: true });
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
        journalFor(window.root, window.file),
        JSON.stringify({ file: window.file, original, injectedHash: hashContent(injected) }),
    );
}

/** The injection is over: there is nothing left to repair. */
export async function clearMutation(window: VerificationWindow): Promise<void> {
    await rm(journalFor(window.root, window.file), { force: true });
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
        mutationWriteRefusal: async (relativePath: string) => {
            if (containedPath(root, relativePath) === null) return `${relativePath} is outside the workspace root`;
            const target = writeTargetFor(root, relativePath);
            return target.ok ? null : target.why;
        },
        writeText: async (relativePath: string, content: string) => {
            const absolute = containedPath(root, relativePath);
            if (absolute === null) {
                // Loud, because this one is the mutation restore path: silently declining to write would leave the
                // injected defect in place, and a mutation that is not restored is a repository left broken.
                throw new Error(`refusing to write ${relativePath}: it is outside the workspace root`);
            }
            // **The rule lives at the write, not at the caller.** `writeFile` follows a symlink, so a write through a path
            // that has become a link lands in whatever it points at — measured by an independent round: a cycle on `a.ts`
            // reported `supported` while `b.ts`, a file it never named, was overwritten with the cycle's original content.
            // Putting the refusal here rather than in the verifier keeps it true for every writer, and keeps it out of the
            // context seam a fixture may replace.
            const target = writeTargetFor(root, relativePath);
            if (!target.ok) {
                throw new Error(`refusing to write ${relativePath}: ${target.why}`);
            }
            await writeFile(absolute, content, 'utf8');
        },
        now,
        producer: () => options.producer,
        ...(options.windowDeadlineMs === undefined ? {} : { windowDeadlineMs: options.windowDeadlineMs }),
    };
}
