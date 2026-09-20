import { describe, expect, it, vi } from 'vitest';
import { discoverCodeGraphCandidates } from '../../src/quality/acceptance-matrix.js';
import type { AcceptanceMatrix } from '../../src/core/task.js';

/**
 * L4-03: bound the fan-out without paying for it in information.
 *
 * One `codegraph affected` per implementation path is what produces the attribution — which path dragged each affected
 * test in — so the finding is about the *scheduling*, not the number of calls. A bounded pool has one obligation the
 * unbounded one did not: a failing query must still fail the discovery, rather than being swallowed by a pool that
 * happened to have room for it.
 */
describe('the CodeGraph fan-out', () => {
    /** `discoverCodeGraphCandidates` derives its paths from the matrix and `ownedPaths`, so the fixture builds both. */
    const matrixOf = (paths: string[]): AcceptanceMatrix => ({
        version: 1,
        rows: [{ acceptanceId: 'AC-1', implementationPaths: paths, testPaths: ['tests/a.test.ts'], evidence: [{ kind: 'test', command: 'npx vitest run tests/a.test.ts', testSelector: 'tests/a.test.ts' }], verificationLevel: 'integration' }],
    });

    it('keeps the per-path attribution', async () => {
        const run = vi.fn(async (_root: string, paths: string[]) => paths.map((path) => `${path}.test`));

        const affected = await discoverCodeGraphCandidates('/repo', matrixOf(['src/a.ts', 'src/b.ts']), ['src'], run);

        expect(affected.find((entry) => entry.path === 'src/a.ts.test')?.sourcePaths).toEqual(['src/a.ts']);
        expect(affected.find((entry) => entry.path === 'src/b.ts.test')?.sourcePaths).toEqual(['src/b.ts']);
    });

    it('runs no more than the bound at once', async () => {
        let inFlight = 0;
        let peak = 0;
        const run = vi.fn(async (_root: string, paths: string[]) => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 5));
            inFlight -= 1;
            return paths;
        });
        const paths = Array.from({ length: 12 }, (_, index) => `src/${index}.ts`);

        await discoverCodeGraphCandidates('/repo', matrixOf(paths), ['src'], run);

        expect(run).toHaveBeenCalledTimes(12);
        expect(peak).toBeLessThanOrEqual(4);
        // Unbounded would have peaked at 12; the bound is the finding, so an unasserted peak is an untested change.
        expect(peak).toBeGreaterThan(1);
    });

    it('fails the whole discovery when one query fails', async () => {
        const run = vi.fn(async (_root: string, paths: string[]) => {
            if (paths[0] === 'src/b.ts') throw new Error('codegraph index unavailable');
            return paths;
        });

        // A bounded pool may not turn "the index could not answer" into "nothing is affected".
        await expect(discoverCodeGraphCandidates('/repo', matrixOf(['src/a.ts', 'src/b.ts']), ['src'], run))
            .rejects.toThrow(/index unavailable/);
    });

    it('reports every path it queried, in matrix order', async () => {
        // The bounded pool fills a `Map` out of order; the result must not inherit that order.
        const run = vi.fn(async (_root: string, paths: string[]) => paths);

        const affected = await discoverCodeGraphCandidates('/repo', matrixOf(['src/b.ts', 'src/a.ts']), ['src'], run);

        expect(affected.map((entry) => entry.path)).toEqual(['src/b.ts', 'src/a.ts']);
    });
});
