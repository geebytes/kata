import { describe, expect, it } from 'vitest';
import { link, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withVerificationWindow } from '../../src/store/verify-context.js';
import { verifyAll } from '../../src/producers/verifiers.js';
import type { VerifyContext } from '../../src/producers/port.js';

/**
 * **Two runs that mutate one file cannot interleave.**
 *
 * Measured by an independent round: two concurrent verification runs left the injected defect in the live checkout
 * (`git diff` non-empty) and the next run reported `refuted … the check was already failing before any mutation`. The
 * window is `read → inject → run → restore`: the second run reads the first's injected content as its original and writes
 * that back. The lock is per file, so this case asserts both halves — the sections do not overlap, and the file ends as it
 * began.
 */
describe('evidence verification is serialized per file', () => {
    it('does not let two sections on one file overlap, and leaves the file as it was found', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-serialize-'));
        const file = 'a.ts';
        let content = 'const x = 1;\n';
        const original = content;
        const events: string[] = [];

        const section = (name: string) => withVerificationWindow(root, file, async () => {
            events.push(`${name}:enter`);
            const read = content;
            await new Promise((resolve) => setTimeout(resolve, 10));
            content = `${read}// injected by ${name}\n`;
            events.push(`${name}:injected`);
            await new Promise((resolve) => setTimeout(resolve, 10));
            content = read;
            events.push(`${name}:exit`);
        });

        await Promise.all([section('A'), section('B')]);

        // **Serialized means "never two inside at once", not "A first".** A fixed-order assertion was flaky (~20% measured by
        // an independent round) because acquisition is a `mkdir` race — and that flakiness made `ledger evidence verify`
        // report the check as already failing. Exclusivity is the property the mechanism actually promises.
        let inside = 0;
        let peak = 0;
        for (const event of events) {
            if (event.endsWith(':enter')) inside += 1;
            if (event.endsWith(':exit')) inside -= 1;
            peak = Math.max(peak, inside);
        }
        expect(peak).toBe(1);
        expect(content).toBe(original);
    });

    it('treats two spellings of one file as one file', async () => {
        // An independent round reproduced the whole hazard through an alias: `a.ts` and `./a.ts` hashed to two different
        // locks, so two cycles interleaved on one file and left the injected defect behind while both reported success.
        const root = await mkdtemp(join(tmpdir(), 'kata-serialize-'));
        let inside = 0;
        let peak = 0;
        const section = (spelling: string) => withVerificationWindow(root, spelling, async () => {
            inside += 1;
            peak = Math.max(peak, inside);
            await new Promise((resolve) => setTimeout(resolve, 15));
            inside -= 1;
        });
        await Promise.all([section('a.ts'), section('./a.ts')]);
        expect(peak).toBe(1);
    });

    it('treats a hard link to one file as the same file', async () => {
        // A hard link shares the inode and has its own path, so a key derived from a *name* leaves the two unserialized: an
        // independent round drove two cycles on `a.ts` and its hard link and the injected defect stayed on disk while both
        // verdicts read `supported`.
        const root = await mkdtemp(join(tmpdir(), 'kata-serialize-'));
        await writeFile(join(root, 'a.ts'), 'const x = 1;\n');
        await link(join(root, 'a.ts'), join(root, 'hard.ts'));
        let inside = 0;
        let peak = 0;
        const section = (name: string) => withVerificationWindow(root, name, async () => {
            inside += 1;
            peak = Math.max(peak, inside);
            await new Promise((resolve) => setTimeout(resolve, 15));
            inside -= 1;
        });
        await Promise.all([section('a.ts'), section('hard.ts')]);
        expect(peak).toBe(1);
    });

    it('leaves the file as it was found when a second cycle waits on the first', async () => {
        // **The hazard the lock alone did not close, at controlled timing.** The original is read *before* the lock, so a run
        // that reads while another is inside captures the *injected* content as its own original and writes it back as its
        // restore — the defect stays on disk while both runs report success (an independent round reproduced it 12/12 with a
        // check that reads its target and then runs long, which is what a real slow suite does). The second cycle is started
        // while the first is inside its window, so the interleaving is arranged rather than hoped for.
        const root = await mkdtemp(join(tmpdir(), 'kata-overlap-'));
        const file = 'a.ts';
        const clean = 'const x = 1;\n';
        await writeFile(join(root, file), clean);
        const context = {
            root,
            subject: { revision: `rev:${'a'.repeat(16)}`, pathDigests: { [file]: 'a'.repeat(64) } },
            // Long enough that the second cycle's read lands inside this one's window.
            run: async () => { await new Promise((resolve) => setTimeout(resolve, 40)); return { code: 0, stdout: '', stderr: '', timedOut: false }; },
            now: () => '2026-10-08T00:00:00.000Z',
            producer: () => 'fixture',
            readText: async (path: string) => (path === file ? await readFile(join(root, file), 'utf8') : null),
            writeText: async (path: string, content: string) => { if (path === file) await writeFile(join(root, file), content); },
        } as unknown as VerifyContext;
        // Two *different* mutations, so neither run bails out on an anchor that does not match and the interleaving is real:
        // the first injects `x = 2`, the second is looking for `x = 2` and finds the first's injection.
        const firstItem = { id: 'E1', type: 'executable_falsifier' as const, command: 'true', mutation: { file, find: 'const x = 1;', replace: 'const x = 2;' } };
        const secondItem = { id: 'E2', type: 'executable_falsifier' as const, command: 'true', mutation: { file, find: 'const x = 2;', replace: 'const x = 3;' } };

        const first = verifyAll([firstItem], context);
        await new Promise((resolve) => setTimeout(resolve, 15));
        const second = verifyAll([secondItem], context);
        // **The waiting cycle is no longer handed a verdict about a tree it does not own.** It waits for the window and then
        // reads the file as this run left it, so its mutation site is simply gone: `inconclusive`, on the site, not on a
        // tree. What must hold either way is that no run restored somebody else's injection and the file is as it was found.
        const outcomes = await Promise.allSettled([first, second]);
        const verdicts = outcomes.flatMap((outcome) => (outcome.status === 'fulfilled' ? outcome.value : []));
        expect(verdicts.some((verdict) => verdict.observed.includes('not restored to green') || verdict.observed.includes('already failing before any mutation'))).toBe(false);
        expect(await readFile(join(root, file), 'utf8')).toBe(clean);
    });

    it('serializes two sections on different files too, and both still complete', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-serialize-'));
        // **The exclusion is the repository's, and this case is why.** A per-file lock was the earlier design, and an
        // independent round broke it three times in a row — a spelling, an inode, a symlink — because "the same file" is not
        // a name a check cannot change. Serializing different files costs concurrency nothing asks for; `verifyAll` runs its
        // items one at a time inside a run anyway, so the only overlap here was between two CLI invocations.
        await writeFile(join(root, 'a.ts'), 'const x = 1;\n');
        await writeFile(join(root, 'b.ts'), 'const y = 1;\n');
        let inside = 0;
        let peak = 0;
        const section = (file: string) => withVerificationWindow(root, file, async () => {
            inside += 1;
            peak = Math.max(peak, inside);
            await new Promise((resolve) => setTimeout(resolve, 15));
            inside -= 1;
        });
        await Promise.all([section('a.ts'), section('b.ts')]);
        expect(peak).toBe(1);
        // Both completed, and neither was refused: the cost of the repository lock is serialization, not starvation.
        expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('const x = 1;\n');
        expect(await readFile(join(root, 'b.ts'), 'utf8')).toBe('const y = 1;\n');
    });
});

/**
 * **The window's own state is not inside the tree the check may write — round 4's second blocking finding.**
 *
 * The lock and the journal used to live at `<root>/.kata/locks`. A verified check runs in that tree and may edit it, so a check
 * that removed the directory made the next cycle's `mkdir` succeed: the round measured `peak=2`, both cycles reporting
 * `supported` with the injected defect left on disk, and a variant where the second cycle reported a false
 * `refuted … did not redden under its own defect`. A mechanism that keeps its exclusion inside the directory it is excluding
 * excludes nothing.
 *
 * The state now lives under the system temp directory, keyed on the repository's real path. This case has the first cycle's
 * body delete the old location, which is what the round's counterexample did.
 */
describe('a check cannot delete the window out from under the mechanism', () => {
    it('still excludes a second cycle when the check removes the old lock directory', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-lock-deleted-'));
        await writeFile(join(root, 'a.ts'), 'const x = 1;\n');
        let inside = 0;
        let peak = 0;
        const first = withVerificationWindow(root, 'a.ts', async () => {
            inside += 1;
            peak = Math.max(peak, inside);
            // What the round's check did: remove the directory the window used to keep its state in.
            await rm(join(root, '.kata', 'locks'), { recursive: true, force: true });
            await new Promise((resolve) => setTimeout(resolve, 120));
            inside -= 1;
        });
        await new Promise((resolve) => setTimeout(resolve, 40));
        const second = withVerificationWindow(root, 'a.ts', async () => {
            inside += 1;
            peak = Math.max(peak, inside);
            await new Promise((resolve) => setTimeout(resolve, 10));
            inside -= 1;
        });
        await Promise.all([first, second]);
        expect(peak).toBe(1);
        await rm(root, { recursive: true, force: true });
    });
});
