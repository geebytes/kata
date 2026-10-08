import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withVerificationLock } from '../../src/store/verify-context.js';

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

        // Serialized: the second section starts only after the first has finished.
        expect(events).toEqual(['A:enter', 'A:injected', 'A:exit', 'B:enter', 'B:injected', 'B:exit']);
        expect(content).toBe(original);
    });

    it('lets two sections on different files overlap', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-serialize-'));
        const events: string[] = [];
        const section = (file: string, name: string) => withVerificationLock(root, file, async () => {
            events.push(`${name}:enter`);
            await new Promise((resolve) => setTimeout(resolve, 10));
            events.push(`${name}:exit`);
        });
        await Promise.all([section('a.ts', 'A'), section('b.ts', 'B')]);
        // Both entered before either left: the lock is per file, not global.
        expect(events.slice(0, 2).sort()).toEqual(['A:enter', 'B:enter']);
    });
});
