import { describe, expect, it } from 'vitest';
import { link, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withVerificationLock } from '../../src/store/verify-context.js';
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

        const section = (name: string) => withVerificationLock(root, file, async () => {
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
        const section = (spelling: string) => withVerificationLock(root, spelling, async () => {
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
        const section = (name: string) => withVerificationLock(root, name, async () => {
            inside += 1;
            peak = Math.max(peak, inside);
            await new Promise((resolve) => setTimeout(resolve, 15));
            inside -= 1;
        });
        await Promise.all([section('a.ts'), section('hard.ts')]);
        expect(peak).toBe(1);
    });

    it('leaves the file as it was found when two cycles overlap on one file', async () => {
        // The hazard the lock alone did not close: the original is read before the lock, so a run that waits while another
        // injects used to capture the injected content as its own original and write it back — the defect stayed on disk
        // while both runs reported success (an independent round reproduced it 12/12).
        const root = await mkdtemp(join(tmpdir(), 'kata-overlap-'));
        const file = 'a.ts';
        const clean = 'const x = 1;\n';
        await writeFile(join(root, file), clean);
        const context = {
            root,
            subject: { revision: `rev:${'a'.repeat(16)}`, pathDigests: { [file]: 'a'.repeat(64) } },
            run: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return { code: 0, stdout: '', stderr: '', timedOut: false }; },
            now: () => '2026-10-08T00:00:00.000Z',
            producer: () => 'fixture',
            readText: async (path: string) => (path === file ? await readFile(join(root, file), 'utf8') : null),
            writeText: async (path: string, content: string) => { if (path === file) await writeFile(join(root, file), content); },
        } as unknown as VerifyContext;
        const item = { id: 'E1', type: 'executable_falsifier' as const, command: 'true', mutation: { file, find: 'const x = 1;', replace: 'const x = 2;' } };

        await Promise.all([verifyAll([item], context), verifyAll([item], context)]);
        expect(await readFile(join(root, file), 'utf8')).toBe(clean);
    });

    it('lets two sections on different files overlap', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-serialize-'));
        // A barrier, not a timing guess: each section waits for the other to be inside. With a per-file lock both get in; a
        // global lock would leave one waiting and the case would fail on its own timeout.
        let inside = 0;
        let releaseBoth: () => void = () => {};
        const bothInside = new Promise<void>((resolve) => { releaseBoth = resolve; });
        const section = (file: string, name: string) => withVerificationLock(root, file, async () => {
            inside += 1;
            if (inside === 2) releaseBoth();
            await Promise.race([
                bothInside,
                new Promise((_, reject) => setTimeout(() => reject(new Error(`${name} waited for the other file's lock: the lock is not per file`)), 2000)),
            ]);
        });
        await Promise.all([section('a.ts', 'A'), section('b.ts', 'B')]);
        expect(inside).toBe(2);
    });
});
