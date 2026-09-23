import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// AC-2. Both reference checks are held to the material they were built from.
//
// Check A's measured basis, as corrected: **23** exported symbols in src/ referenced nowhere — the 2026-09-22 measurement
// said 24, and the 24th was the false positive f1 removed (`runWiringCheckCommand`, which `scripts/wiring-check.mjs`
// calls), so the check was right to stop reporting it and the count is 23, not 24. A further 38 had a reference under
// `tests/` and are a different class, reported separately.
//
// Check B's measured basis is a **negative** one: the harness that produced the 2026-09-22 numbers used a regex whose
// `[^\]]*` spans newlines, so an apostrophe in prose inside a multi-line list was taken for a string boundary and produced
// rows like `s findings, which the review node resets at the start of a round`. Roughly 4 of its 11 rows survived. So the
// multi-line case is the regression test, not an edge case.

async function fixture(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-wiring-ref-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'tests/unit'), { recursive: true });
    return root;
}

describe('the reference checks', () => {
    it('reports an exported function production code never calls', async () => {
        const root = await fixture();
        try {
            await writeFile(join(root, 'src/orphan.ts'), 'export function orphan(): number { return 1; }\n', 'utf8');
            await writeFile(join(root, 'src/live.ts'), 'export function live(): number { return 2; }\n', 'utf8');
            await writeFile(join(root, 'src/caller.ts'), "import { live } from './live.js';\nexport const v = live();\n", 'utf8');

            const { findUnreferencedExports } = await import('../../src/quality/wiring-check.js');
            const findings = await findUnreferencedExports({ root, surface: ['src/orphan.ts', 'src/live.ts'], search: ['src'] });

            expect(findings.map((f) => f.subject)).toContain('orphan');
            // `live` is called by production code, so it is not a finding.
            expect(findings.map((f) => f.subject)).not.toContain('live');
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('distinguishes a symbol referenced only by tests from one referenced nowhere', async () => {
        const root = await fixture();
        try {
            await writeFile(join(root, 'src/testonly.ts'), 'export function testOnly(): number { return 1; }\n', 'utf8');
            await writeFile(join(root, 'tests/unit/a.test.ts'), "import { testOnly } from '../../src/testonly.js';\ntestOnly();\n", 'utf8');

            const { findUnreferencedExports } = await import('../../src/quality/wiring-check.js');
            const findings = await findUnreferencedExports({ root, surface: ['src/testonly.ts'], search: ['src'], testGlobs: ['tests'] });

            const finding = findings.find((f) => f.subject === 'testOnly');
            expect(finding).toBeDefined();
            // The distinction is the point: production code with no production consumer is the finding, and whether a test
            // keeps it alive is reported rather than folded in.
            expect(finding!.detail).toMatch(/test/i);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('parses a multi-line declared list, including an apostrophe in prose', async () => {
        const root = await fixture();
        try {
            await writeFile(
                join(root, 'src/lists.ts'),
                [
                    'export const BRIEF_INPUTS = [',
                    "    // it's the node's own record, so it moves when the pass lands",
                    "    'the adversarial record of the pass being recorded',",
                    "    'the sealed revision',",
                    '] as const;',
                    '',
                    'export const CONSUMED = [',
                    "    'used',",
                    "    'unused',",
                    '] as const;',
                    '',
                    "export const take = (): string => CONSUMED[0] + 'used';",
                    '',
                ].join('\n'),
                'utf8',
            );

            const { findUnconsumedDeclaredMembers } = await import('../../src/quality/wiring-check.js');
            const findings = await findUnconsumedDeclaredMembers({ root, surface: ['src/lists.ts'] });
            const subjects = findings.map((f) => f.subject);

            // The real members of the unconsumed list are the finding…
            expect(subjects.some((s) => s.includes('the sealed revision'))).toBe(true);
            // …and no row is a fragment of prose. This is the assertion the regex harness would fail.
            for (const subject of subjects) {
                expect(subject.startsWith('s ')).toBe(false);
                expect(subject.length).toBeGreaterThan(3);
                expect(subject).not.toMatch(/review node resets/);
            }
            // A member the code consumes is not a finding.
            expect(subjects.some((s) => s === 'used')).toBe(false);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
