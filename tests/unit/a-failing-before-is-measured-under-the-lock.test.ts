import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyAll } from '../../src/producers/verifiers.js';
import type { VerifyContext } from '../../src/producers/port.js';

/**
 * **A failing `before` may be measuring somebody else's injection.**
 *
 * The check is run once before the mutation, and a concurrent cycle holds the file injected for its whole window — so a run
 * that measures the tree there reports `the check was already failing before any mutation`, which points at the check while
 * the tree was the problem. That sentence is the misdiagnosis this whole change exists to remove, so the failure is
 * re-measured under the lock before it is believed.
 */
describe('a failing before is measured under the lock', () => {
    it('does not report the check as already failing when another cycle held the file injected', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-before-'));
        const file = 'a.ts';
        await writeFile(join(root, file), 'const x = 1;\n');
        // The check fails exactly while the injected content is on disk, which is what a mutation-based check does.
        const context = {
            root,
            subject: { revision: `rev:${'a'.repeat(16)}`, pathDigests: { [file]: 'a'.repeat(64) } },
            now: () => '2026-10-08T00:00:00.000Z',
            producer: () => 'fixture',
            run: async () => {
                const content = await readFile(join(root, file), 'utf8');
                await new Promise((resolve) => setTimeout(resolve, 30));
                return { code: content.includes('const x = 2;') ? 1 : 0, stdout: '', stderr: '', timedOut: false };
            },
            readText: async (path: string) => (path === file ? await readFile(join(root, file), 'utf8') : null),
            writeText: async (path: string, content: string) => { if (path === file) await writeFile(join(root, file), content); },
        } as unknown as VerifyContext;
        const firstItem = { id: 'E1', type: 'executable_falsifier' as const, command: 'true', mutation: { file, find: 'const x = 1;', replace: 'const x = 2;' } };
        const secondItem = { id: 'E2', type: 'executable_falsifier' as const, command: 'true', mutation: { file, find: 'const x = 1;', replace: 'const x = 2;' } };

        const first = verifyAll([firstItem], context);
        await new Promise((resolve) => setTimeout(resolve, 10));
        const second = verifyAll([secondItem], context);
        const outcomes = await Promise.allSettled([first, second]);
        const verdicts = outcomes.flatMap((outcome) => (outcome.status === 'fulfilled' ? outcome.value : []));
        expect(verdicts.some((verdict) => verdict.verdict === 'supported')).toBe(true);
        expect(verdicts.map((verdict) => verdict.observed).join(' ')).not.toContain('already failing before any mutation');
        expect(await readFile(join(root, file), 'utf8')).toBe('const x = 1;\n');
    });
});
