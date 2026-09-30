import { lstatSync, realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
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
 * A path that does not exist resolves through its nearest existing ancestor: `tmp/new.json` is judged by where
 * `tmp` really is, which is the fact a lexical fence cannot see.
 */
function realContainedPath(root: string, absolute: string): boolean {
    // **A link is refused before its target is consulted, because a dangling one has no target to consult.** The first
    // version walked up to the nearest existing ancestor with `existsSync` — which follows symlinks — so a link whose
    // target did not exist yet read as "the path is absent", the fence rebuilt it under the ancestor's realpath (inside
    // the workspace), and the write then followed the link and created the file outside it. Per-segment `lstat` is what
    // sees the link itself; `existsSync` is what cannot.
    const segments = relative(root, absolute).replaceAll('\\', '/').split('/').filter((entry) => entry !== '');
    let probe = resolve(root);
    for (const [index, segment] of segments.entries()) {
        probe = resolve(probe, segment);
        const last = index === segments.length - 1;
        let stats;
        try {
            stats = lstatSync(probe);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                // Absent from here down: nothing below the first missing segment exists, so the rest cannot be a link.
                // The directory the write will land in is the last segment that did exist, and it was checked above.
                // Every segment that exists was checked for links; the rest does not exist yet, and a path that does
                // not exist cannot leave the workspace. The write lands in the directory just verified.
                return true;
            }
            return false;
        }
        // Any symlink on the path — including the final segment, and including a dangling one — is refused rather than
        // resolved: the fence's job is to say "this spelling stays inside", and a link is a second spelling.
        if (stats.isSymbolicLink()) return false;
        if (!last && !stats.isDirectory()) return false;
    }
    const realRoot = realpathSync(root);
    const inside = relative(realRoot, probe).replaceAll('\\', '/');
    return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside);
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
