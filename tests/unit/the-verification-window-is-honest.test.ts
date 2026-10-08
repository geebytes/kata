import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyAll } from '../../src/producers/verifiers.js';
import { buildContext } from '../../src/store/verify-context.js';
import { withVerificationWindow } from '../../src/store/verify-context.js';
import type { VerifyContext } from '../../src/producers/port.js';

/**
 * **A reading has to say what it ran.**
 *
 * Every falsifier persisted the same `{"before":0,"mutated":1,"after":0}`, so four readings were indistinguishable in the
 * store: a reader could not tell which mutation produced which verdict. The observed string now carries the evidence id and
 * the mutated file, which is what makes the record answer "which reading is this".
 */
const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('a reading names its falsifier', () => {
    it('records the evidence id and the mutated file in the observation', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-observed-'));
        roots.push(root);
        const file = 'a.ts';
        await writeFile(join(root, file), 'const x = 1;\n');
        const context = {
            root,
            subject: { revision: `rev:${'a'.repeat(16)}`, pathDigests: { [file]: 'a'.repeat(64) } },
            run: async () => {
                const content = await readFile(join(root, file), 'utf8');
                return { code: content.includes('const x = 2;') ? 1 : 0, stdout: '', stderr: '', timedOut: false };
            },
            now: () => '2026-10-08T00:00:00.000Z',
            producer: () => 'fixture',
            readText: async (path: string) => (path === file ? await readFile(join(root, file), 'utf8') : null),
            writeText: async (path: string, content: string) => { if (path === file) await writeFile(join(root, file), content); },
        } as unknown as VerifyContext;
        const item = { id: 'E7', type: 'executable_falsifier' as const, command: 'true', mutation: { file, find: 'const x = 1;', replace: 'const x = 2;' } };

        const verdicts = await verifyAll([item], context);
        expect(verdicts[0].observed).toContain('E7');
        expect(verdicts[0].observed).toContain(file);
    });
});

/**
 * **The window is exclusive, and a run that cannot get one is told rather than handed a verdict.**
 *
 * The cycle used to hold the file only from the injection to the restore, so the *closing* check ran outside it. An
 * independent round measured the consequence: a valid evidence item was downgraded to `inconclusive … the tree was not
 * restored to green` because the closing check landed inside another cycle's injection while the checkout was byte-identical
 * to clean. The first case arranges that interleaving instead of hoping for it — the second cycle is started exactly while
 * the first is at its closing check, and the first cycle's closing check waits for the second to inject.
 */
describe('the window is exclusive and honest to observers', () => {
    const clean = 'const a = 1;\nconst b = 1;\n';
    const file = 'a.ts';

    /** Red exactly when the file holds an injected defect, whichever cycle put it there. */
    const measure = async (root: string) => {
        const content = await readFile(join(root, file), 'utf8');
        return { code: content.includes('= 2;') ? 1 : 0, stdout: '', stderr: '', timedOut: false };
    };

    const contextFor = (root: string, plan: { mutated?: () => void | Promise<void>; closing?: () => Promise<void> }) => {
        let calls = 0;
        return {
            root,
            subject: { revision: `rev:${'a'.repeat(16)}`, pathDigests: { [file]: 'a'.repeat(64) } },
            run: async () => {
                calls += 1;
                if (calls === 2) await plan.mutated?.();
                if (calls === 3) await plan.closing?.();
                return measure(root);
            },
            now: () => '2026-10-08T00:00:00.000Z',
            producer: () => 'fixture',
            readText: async (path: string) => (path === file ? await readFile(join(root, file), 'utf8') : null),
            writeText: async (path: string, content: string) => { if (path === file) await writeFile(join(root, file), content); },
        } as unknown as VerifyContext;
    };

    it('does not let a closing check land inside another cycle, and does not downgrade either reading', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-window-'));
        roots.push(root);
        await writeFile(join(root, file), clean);

        let reachedClosing: () => void = () => {};
        const closingCheck = new Promise<void>((resolve) => { reachedClosing = resolve; });
        let secondInjected: () => void = () => {};
        const secondWindowLive = new Promise<void>((resolve) => { secondInjected = resolve; });

        const first = verifyAll(
            [{ id: 'E1', type: 'executable_falsifier' as const, command: 'true', mutation: { file, find: 'const a = 1;', replace: 'const a = 2;' } }],
            contextFor(root, {
                // **The closing check waits for the other cycle to inject, or gives up after a bound.** With the cycle inside
                // one window the other cycle cannot get in at all, so the bound is what it waits out — and the reading it then
                // takes is of a tree this run owns.
                closing: async () => { reachedClosing(); await Promise.race([secondWindowLive, new Promise((resolve) => setTimeout(resolve, 400))]); },
            }),
        );
        await closingCheck;
        const second = verifyAll(
            [{ id: 'E2', type: 'executable_falsifier' as const, command: 'true', mutation: { file, find: 'const b = 1;', replace: 'const b = 2;' } }],
            contextFor(root, {
                mutated: async () => { secondInjected(); await new Promise((resolve) => setTimeout(resolve, 200)); },
            }),
        );
        const [firstVerdicts, secondVerdicts] = await Promise.all([first, second]);

        // Neither reading is downgraded, and neither blames the tree for a defect it does not hold.
        expect(firstVerdicts[0].verdict).toBe('supported');
        expect(secondVerdicts[0].verdict).toBe('supported');
        for (const verdict of [...firstVerdicts, ...secondVerdicts]) {
            expect(verdict.observed).not.toContain('not restored to green');
            expect(verdict.observed).not.toContain('already failing before any mutation');
        }
        expect(await readFile(join(root, file), 'utf8')).toBe(clean);
    });

    it('tells a run that a window is live instead of handing it a verdict', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-live-window-'));
        roots.push(root);
        await writeFile(join(root, file), clean);
        // A short bound, so the guard measures the *answer* rather than waiting out the production envelope.
        const context = { ...contextFor(root, {}), windowDeadlineMs: 80 } as unknown as VerifyContext;
        const item = { id: 'E3', type: 'executable_falsifier' as const, command: 'true', mutation: { file, find: 'const a = 1;', replace: 'const a = 2;' } };

        // The window is held here, the way a cycle holds it: this run's file is mutated by somebody else right now.
        await withVerificationWindow(root, file, async () => {
            const outcome = await Promise.allSettled([verifyAll([item], context)]);
            expect(outcome[0].status).toBe('rejected');
            const reason = String((outcome[0] as PromiseRejectedResult).reason);
            expect(reason).toContain('a verification window is live');
            // **And it is not a verdict.** A caller that received `inconclusive` here would be reading a statement about a
            // tree this run never owned, which is the misdiagnosis the window exists to remove.
            expect(reason).not.toContain('inconclusive');
        });
        // With the window released the same run is ordinary: the mechanism refuses to answer only while it must.
        expect((await verifyAll([item], context))[0].verdict).toBe('supported');
    });
});

/**
 * **A cycle that replaces its own target must still exclude the next one.**
 *
 * Round 1's blocking finding, in the form a correct implementation can satisfy. The window key used to be derived *before*
 * the window was held, and it was the file's inode; a check that lands its result with `mv` — an ordinary formatter — moved
 * the inode in between, so the next cycle derived a different key, took a lock nobody held, and ran concurrently. It then
 * found the first cycle's journal by file name, restored the first cycle's original mid-flight, and the first cycle reported
 * `refuted … the check did not redden under its own defect` about a check that is perfectly sensitive.
 *
 * The reviewer's own probe could not be satisfied by any correct implementation (it awaited the second cycle to completion
 * while the first was parked inside its window, which only a cycle that does not exclude the first can do), so the same
 * property is asserted here directly: the first reading stays `supported`, and the second cycle is either served after it or
 * told by name.
 */
describe('a cycle that replaces its own target still excludes the next one', () => {
    it('keeps the first reading supported and serves or names the second cycle', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-inode-move-'));
        roots.push(root);
        const file = 'a.ts';
        const moved = 'const a = 1;\nconst b = 1;\n';
        await writeFile(join(root, file), moved);

        let signalInjected: () => void = () => {};
        const injected = new Promise<void>((resolve) => { signalInjected = resolve; });
        const contextFor = (label: string, windowDeadlineMs: number, onMutated?: () => Promise<void>) => {
            let calls = 0;
            return {
                root,
                subject: { revision: `rev:${'a'.repeat(16)}`, pathDigests: { [file]: 'a'.repeat(64) } },
                windowDeadlineMs,
                run: async () => {
                    calls += 1;
                    if (calls === 2 && onMutated) await onMutated();
                    const content = await readFile(join(root, file), 'utf8');
                    return { code: content.includes('= 2;') ? 1 : 0, stdout: label, stderr: '', timedOut: false };
                },
                now: () => '2026-10-08T00:00:00.000Z',
                producer: () => `fixture-${label}`,
                readText: async (path: string) => (path === file ? await readFile(join(root, file), 'utf8') : null),
                writeText: async (path: string, content: string) => { if (path === file) await writeFile(join(root, file), content); },
            } as unknown as VerifyContext;
        };

        const first = verifyAll(
            [{ id: 'EA', type: 'executable_falsifier' as const, command: 'true', mutation: { file, find: 'const a = 1;', replace: 'const a = 2;' } }],
            contextFor('A', 5_000, async () => {
                // The atomic replace: same path, new inode, inside this cycle's own window.
                const temp = join(root, '.replacement-a.ts');
                await writeFile(temp, await readFile(join(root, file), 'utf8'));
                await rename(temp, join(root, file));
                signalInjected();
                await new Promise((resolve) => setTimeout(resolve, 300));
            }),
        );
        await injected;
        const second = verifyAll(
            [{ id: 'EB', type: 'executable_falsifier' as const, command: 'true', mutation: { file, find: 'const b = 1;', replace: 'const b = 2;' } }],
            contextFor('B', 2_000),
        );

        const [firstSettled, secondSettled] = await Promise.allSettled([first, second]);
        expect(firstSettled.status).toBe('fulfilled');
        if (firstSettled.status === 'fulfilled') expect(firstSettled.value[0].verdict).toBe('supported');
        if (secondSettled.status === 'rejected') {
            expect(String(secondSettled.reason)).toContain('a verification window is live');
        } else {
            expect(secondSettled.value[0].verdict).toBe('supported');
        }
        expect(await readFile(join(root, file), 'utf8')).toBe(moved);
    }, 15_000);
});

/**
 * **A cycle may replace its own target; it may not turn it into a door into somebody else's file.**
 *
 * Round 2's blocking finding, and the one case in this family that needs no concurrency at all. The restore write goes
 * through the path and `writeFile` follows symlinks, so a check that swaps its target for a link to another file makes the
 * restore land in *that* file: measured, a cycle on `a.ts` reported `supported` while `b.ts` — a file it never named — was
 * overwritten with the cycle's original content, and `a.ts` was left as a symlink.
 *
 * **The context is the real one** (`buildContext`), and the swap is done by the check's own shell command. The first
 * version of this case drove a synthetic context, which overrides `writeText` — so the guard it was written for was never
 * reached and the case passed for the wrong reason. That is the third time in this change a fixture stood in the way of the
 * code it was measuring.
 */
describe('a restore never writes through a link', () => {
    it('refuses to restore into the file a swapped-in symlink points at', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-symlink-restore-'));
        roots.push(root);
        const file = 'a.ts';
        const peer = 'b.ts';
        const clean = 'const x = 1;\n';
        const peerContent = 'const b = 1;\n';
        await writeFile(join(root, file), clean);
        await writeFile(join(root, peer), peerContent);

        // The check reddens under the injected defect, and lands its result by making its own target a link to `b.ts`. On the
        // opening run the file still holds the original, so it exits 0 and the cycle proceeds.
        const context = buildContext(root, { revision: `rev:${'a'.repeat(16)}`, pathDigests: { [file]: 'a'.repeat(64) } }, { timeoutMs: 10_000, producer: 'fixture' as never });
        const item = {
            id: 'EA',
            type: 'executable_falsifier' as const,
            command: `sh -c 'if grep -q "const x = 2" a.ts; then rm -f a.ts && ln -s b.ts a.ts; exit 1; fi; exit 0'`,
            mutation: { file, find: 'const x = 1;', replace: 'const x = 2;' },
        };

        // **The refusal names the fact.** The write would land in `b.ts` through the link, so the restore refuses before
        // writing anything: `refusing to write a.ts: a.ts is a symbolic link, …`.
        await expect(verifyAll([item], context)).rejects.toThrow(/refusing to write a\.ts: a\.ts is a symbolic link/);
        // **The file the cycle never named is untouched.** This is the harm the refusal exists for.
        expect(await readFile(join(root, peer), 'utf8')).toBe(peerContent);
    });
});

/**
 * **Two more shapes that move the file without moving the path — measured by round 3.**
 *
 * The direct-symlink case above is caught by "is the target still a regular file?". These two are not: a **hard link** is a
 * regular file (whose inode is shared with a peer, so the write lands in the peer), and a **symlinked parent directory** keeps
 * the final component a regular file while `lstat` follows the intermediate link. Both were measured producing a `supported`
 * verdict beside a file the run never named.
 *
 * The rule that closes both is the identity the cycle mutated: the restore writes back to *that* file or the run fails.
 */
describe('a restore writes only to the file the cycle mutated', () => {
    const swapCheck = (command: string) => ({
        id: 'EA',
        type: 'executable_falsifier' as const,
        command,
        mutation: { file: 'a.ts', find: 'const x = 1;', replace: 'const x = 2;' },
    });

    it('refuses when a peer is hard-linked over the target', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-hardlink-restore-'));
        roots.push(root);
        const clean = 'const x = 1;\n';
        const peerContent = 'const b = 1;\n';
        await writeFile(join(root, 'a.ts'), clean);
        await writeFile(join(root, 'b.ts'), peerContent);
        const context = buildContext(root, { revision: `rev:${'a'.repeat(16)}`, pathDigests: { 'a.ts': 'a'.repeat(64) } }, { timeoutMs: 10_000, producer: 'fixture' as never });

        // The check reddens under the injected defect and lands its result by making its target a second name for `b.ts`.
        await expect(verifyAll([swapCheck(`sh -c 'if grep -q "const x = 2" a.ts; then ln -f b.ts a.ts; exit 1; fi; exit 0'`)], context))
            .rejects.toThrow(/refusing to write a\.ts: a\.ts has 2 names/);
        expect(await readFile(join(root, 'b.ts'), 'utf8')).toBe(peerContent);
    });

    it('refuses when the parent directory is swapped for a symlink', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-parentlink-restore-'));
        roots.push(root);
        const clean = 'const x = 1;\n';
        const otherContent = 'const other = 1;\n';
        await mkdir(join(root, 'sub'), { recursive: true });
        await mkdir(join(root, 'other'), { recursive: true });
        await writeFile(join(root, 'sub', 'a.ts'), clean);
        await writeFile(join(root, 'other', 'a.ts'), otherContent);
        const context = buildContext(root, { revision: `rev:${'a'.repeat(16)}`, pathDigests: { 'sub/a.ts': 'a'.repeat(64) } }, { timeoutMs: 10_000, producer: 'fixture' as never });
        const item = {
            id: 'EA',
            type: 'executable_falsifier' as const,
            command: `sh -c 'if grep -q "const x = 2" sub/a.ts; then rm -rf sub && ln -s other sub; exit 1; fi; exit 0'`,
            mutation: { file: 'sub/a.ts', find: 'const x = 1;', replace: 'const x = 2;' },
        };

        await expect(verifyAll([item], context)).rejects.toThrow(/refusing to write sub\/a\.ts: sub is a symbolic link/);
        expect(await readFile(join(root, 'other', 'a.ts'), 'utf8')).toBe(otherContent);
    });
});

/**
 * **A legitimate check that lands its result with an atomic replace still verifies — and this case exists because it stopped
 * doing so.**
 *
 * Round 4 measured the regression the previous repair introduced: the cycle compared the target's `dev`+`ino` before and
 * after the mutation and refused on any change, so a formatter-shaped check (`cp a.ts .tmp && mv .tmp a.ts`) threw
 * `UnrestoredMutation`, **left the injected defect on disk**, and failed the whole run. A rule that breaks honest evidence is
 * worse than the hole it closes, so the rule is now about the path and the file it reaches (no symlink in the chain, a regular
 * file, one name) and never about an identity derived earlier. The two cases that appeared to cover this passed only because
 * their synthetic context omitted the seam — the same shape as three other guards in this change.
 */
describe('an honest check may replace its own target', () => {
    const withRealContext = async (root: string, file: string) =>
        buildContext(root, { revision: `rev:${'a'.repeat(16)}`, pathDigests: { [file]: 'a'.repeat(64) } }, { timeoutMs: 10_000, producer: 'fixture' as never });

    it('verifies a check that lands its result with an atomic rename', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-legit-mv-'));
        roots.push(root);
        const clean = 'const x = 1;\n';
        await writeFile(join(root, 'a.ts'), clean);
        const item = {
            id: 'EA',
            type: 'executable_falsifier' as const,
            command: `sh -c 'if grep -q "const x = 2" a.ts; then cp a.ts .tmp && mv .tmp a.ts && exit 1; fi; exit 0'`,
            mutation: { file: 'a.ts', find: 'const x = 1;', replace: 'const x = 2;' },
        };
        const verdicts = await verifyAll([item], await withRealContext(root, 'a.ts'));
        expect(verdicts[0].verdict).toBe('supported');
        // **The checkout is as it was found.** The regression left the injected defect here.
        expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe(clean);
    });

    it('verifies a check that deletes and recreates its target', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-legit-recreate-'));
        roots.push(root);
        const clean = 'const x = 1;\n';
        await writeFile(join(root, 'a.ts'), clean);
        const item = {
            id: 'EA',
            type: 'executable_falsifier' as const,
            command: `sh -c 'if grep -q "const x = 2" a.ts; then cat a.ts > .keep && rm a.ts && mv .keep a.ts && exit 1; fi; exit 0'`,
            mutation: { file: 'a.ts', find: 'const x = 1;', replace: 'const x = 2;' },
        };
        const verdicts = await verifyAll([item], await withRealContext(root, 'a.ts'));
        expect(verdicts[0].verdict).toBe('supported');
        expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe(clean);
    });
});

/**
 * **The checkout is as the run found it when the cycle ends — not just when the restore lands.**
 *
 * Round 4's note: the closing check runs inside the window, but nothing re-read the file afterwards, so a check whose green
 * run rewrites its own target left that rewrite behind while the cycle reported `supported` (measured: the trailing newline
 * was gone). A formatter that normalises the file does it on the opening run as well, so `original` is already its output and
 * this refusal does not catch an honest check.
 */
describe('a green run that rewrites its target is named, not reported', () => {
    it('refuses when the checkout differs from what the cycle restored', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-settled-'));
        roots.push(root);
        const clean = 'const x = 1;\n';
        await writeFile(join(root, 'a.ts'), clean);
        const context = buildContext(root, { revision: `rev:${'a'.repeat(16)}`, pathDigests: { 'a.ts': 'a'.repeat(64) } }, { timeoutMs: 10_000, producer: 'fixture' as never });
        const item = {
            id: 'EA',
            type: 'executable_falsifier' as const,
            // Every run appends to its own target, so the closing run leaves a change behind: the tree is no longer as it
            // was found. The opening run's append is part of `original` (it is read after that run), which is why an honest
            // normaliser is not caught by this refusal.
            command: `sh -c 'printf "// touched\\n" >> a.ts; if grep -q "const x = 2" a.ts; then exit 1; fi; exit 0'`,
            mutation: { file: 'a.ts', find: 'const x = 1;', replace: 'const x = 2;' },
        };
        await expect(verifyAll([item], context)).rejects.toThrow(/checkout is not as it was found/);
    });
});
