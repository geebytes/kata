import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// AC-3. The mutation check's machinery, held to the four ways the 2026-09-22 run got it wrong:
//
//   1. a mutation in the caller's tree would supersede the revision that tree sealed — so it runs in a scratch copy;
//   2. a broken mutation reddens many files at once and reads as "detected" — so a collapse is discounted by a count;
//   3. an unapplied mutation (guessed identifier) must be reported as unapplied, counted on neither side;
//   4. a partial mutation stays green and reads as "blind" — which is why the command under test must be able to notice
//      the guard at all, and why the check reports the failing-file count rather than a boolean.
//
// The per-mutation command is a parameter, so this file can exercise the machinery without nesting a test runner inside a
// test runner. AC-4 is what holds the check to the real material.

const SRC = `export function check(bad: boolean, other: boolean): { ok: boolean; reason?: string } {
    if (bad) {
        return { ok: false, reason: 'the first input was rejected' };
    }
    if (other) {
        return { ok: false, reason: 'the second input was rejected' };
    }
    return { ok: true };
}
`;

/** Notices a mutation of the FIRST guard only. */
const NOTICES_FIRST = ['-e', "const s=require('node:fs').readFileSync('src/guard.ts','utf8');if(!/if \\(bad\\)/.test(s)){console.log(' FAIL tests/guard.test.ts');process.exit(1)}"];

async function fixture(): Promise<string> {
    const base = join(process.cwd(), 'tmp');
    await mkdir(base, { recursive: true });
    const root = await mkdtemp(join(base, 'wiring-check-mutation-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/guard.ts'), SRC, 'utf8');
    return root;
}

describe('the mutation check', () => {
    it('mutates a scratch copy, never the caller tree, and separates decorative from noticed', async () => {
        const root = await fixture();
        try {
            const before = await readFile(join(root, 'src/guard.ts'), 'utf8');
            const { findDecorativeGuards } = await import('../../src/quality/wiring-check.js');

            const results = await findDecorativeGuards({
                root,
                scratch: join(root, 'scratch'),
                surface: ['src/guard.ts'],
                testCommand: { command: process.execPath, args: NOTICES_FIRST },
            });

            const decorative = results.filter((r) => r.status === 'decorative');
            const noticed = results.filter((r) => r.status === 'noticed');

            // The guard the command notices is not reported; the one it cannot notice is.
            expect(decorative.map((r) => r.guard.condition)).toEqual(['other']);
            expect(noticed.map((r) => r.guard.condition)).toEqual(['bad']);
            expect(noticed[0]!.failingFiles).toBeGreaterThan(0);

            // The caller's tree is byte-identical afterwards — the whole point of the scratch copy.
            expect(await readFile(join(root, 'src/guard.ts'), 'utf8')).toBe(before);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('discounts a collapse instead of reading it as a detection', async () => {
        const root = await fixture();
        try {
            const { findDecorativeGuards } = await import('../../src/quality/wiring-check.js');
            const results = await findDecorativeGuards({
                root,
                scratch: join(root, 'scratch'),
                surface: ['src/guard.ts'],
                // Eight files red at once is a type/compile collapse, not a test that noticed a guard.
                testCommand: { command: process.execPath, args: ['-e', "for(let i=0;i<8;i++)console.log(' FAIL tests/x'+i+'.test.ts');process.exit(1)"] },
                collapseThreshold: 5,
            });

            expect(results.length).toBeGreaterThan(0);
            for (const result of results) {
                expect(result.status).toBe('collapse');
                expect(result.failingFiles).toBeGreaterThan(5);
            }
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('reports an unapplied mutation as unapplied rather than counting it on either side', async () => {
        const root = await fixture();
        try {
            const { applyMutation } = await import('../../src/quality/wiring-check.js');
            const copy = join(root, 'copy');
            await mkdir(join(copy, 'src'), { recursive: true });
            await writeFile(join(copy, 'src/guard.ts'), SRC, 'utf8');

            const applied = await applyMutation(copy, {
                file: 'src/guard.ts',
                line: 2,
                condition: 'bad',
                text: '    if (bad) {',
            });
            expect(applied.status).toBe('applied');

            // The same guard again: its anchor is gone, so the second attempt must not be counted as a detection.
            const again = await applyMutation(copy, {
                file: 'src/guard.ts',
                line: 2,
                condition: 'bad',
                text: '    if (bad) {',
            });
            expect(again.status).toBe('unapplied');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
