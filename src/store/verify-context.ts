import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
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
    if (relativePath.trim() === '' || isAbsolute(relativePath)) return null;
    const absolute = resolve(root, relativePath);
    const inside = relative(root, absolute).replaceAll('\\', '/');
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return null;
    return absolute;
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
