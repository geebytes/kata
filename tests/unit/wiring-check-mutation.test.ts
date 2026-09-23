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

/**
 * f2 of the independent pass's findings, and AC-4's assertion.
 *
 * AC-4 claims a test runs the checks against **the material they were built from**. The declared selector did not: it
 * asserted that 15 recorded `file::condition` sites are a subset of the enumerated set — static enumeration, no suite run —
 * and the classification against real material was covered only by a scripted stand-in command. That proves the plumbing,
 * not the judgement: a stub that emits FAIL lines on demand cannot show that the check reads a real runner's behaviour.
 *
 * Measured, the claim "the 15 are reported" cannot be held: re-measured, 0 guards on that surface were decorative. So what
 * is asserted here is the **classification**, against a real repository, a real test runner and a real untested guard.
 */
describe('the decorative classification, on real material rather than a scripted command', () => {
    it('reports the guard no real test exercises, and not the one that is exercised', async () => {
        const { mkdir, mkdtemp, rm, writeFile } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const root = await mkdtemp(join(tmpdir(), 'kata-mutation-real-'));
        try {
            await mkdir(join(root, 'src'), { recursive: true });
            await mkdir(join(root, 'tests'), { recursive: true });
            await writeFile(
                join(root, 'src/guard.mjs'),
                [
                    'export function check(kind) {',
                    "    if (kind === 'a') {",
                    "        throw new Error('refused a');",
                    '    }',
                    "    if (kind === 'b') {",
                    "        throw new Error('refused b');",
                    '    }',
                    "    return 'ok';",
                    '}',
                    '',
                ].join('\n'),
                'utf8',
            );
            // A real test that exercises exactly one of the two guards, run by a real runner.
            await writeFile(
                join(root, 'tests/guard.test.mjs'),
                [
                    "import { test } from 'node:test';",
                    "import assert from 'node:assert';",
                    "import { check } from '../src/guard.mjs';",
                    "test('refuses a', () => { assert.throws(() => check('a')); });",
                    '',
                ].join('\n'),
                'utf8',
            );

            const { findDecorativeGuards } = await import('../../src/quality/wiring-check.js');
            const results = await findDecorativeGuards({
                root,
                scratch: join(root, 'scratch'),
                surface: ['src/guard.mjs'],
                testCommand: { command: process.execPath, args: ['--test', 'tests/guard.test.mjs'] },
            });

            // The exercised guard is noticed — its mutation really does redden the suite — and the unexercised one is not.
            expect(results.filter((r) => r.status === 'noticed').map((r) => r.guard.line)).toHaveLength(1);
            const decorative = results.filter((r) => r.status === 'decorative');
            expect(decorative).toHaveLength(1);
            // `text` is the guard's own `if (...) {` line, which is the mutation anchor.
            expect(decorative[0]!.guard.text).toContain("kind === 'b'");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    }, 120000);
});
