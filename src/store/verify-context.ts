import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { runProcess } from '../process/run.js';
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

export function buildContext(
    root: string,
    subject: Subject,
    options: { timeoutMs: number; producer: VerdictProducer; onRefusal?: (what: string) => void; now?: () => string },
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
    };
}
