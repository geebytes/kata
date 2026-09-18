import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveRelevantChecks, rowsForChangedPaths } from '../../src/quality/relevant-checks.js';
import type { AcceptanceMatrix } from '../../src/core/task.js';
import type { CheckCommand } from '../../src/quality/evidence.js';

/**
 * Which checks a change touches is derived by the platform (F4 of the finding-lifecycle design).
 *
 * The alternative the design rejects is per-project tiering: every project hand-sorting its own checks, which turns one
 * general problem into N configurations. The derivation uses what the platform already has — the change surface and the
 * acceptance matrix — and **falls back to the full set whenever it cannot be sure**, because a derivation that silently
 * under-runs is worse than no derivation.
 */
const row = (acceptanceId: string, implementationPaths: string[], testPaths: string[], command: string) => ({
    acceptanceId,
    implementationPaths,
    testPaths,
    verificationLevel: 'unit' as const,
    evidence: [{ id: `${acceptanceId}-check`, kind: 'test' as const, command }],
});

describe('relevant checks are derived from the change surface and the matrix', () => {
    beforeEach(() => vi.restoreAllMocks());

    const matrix: AcceptanceMatrix = {
        version: 1,
        rows: [
            row('AC-1', ['src/alpha.ts'], ['tests/alpha.test.ts'], 'node --test alpha'),
            row('AC-2', ['src/beta.ts'], ['tests/beta.test.ts'], 'node --test beta'),
        ],
    };
    // The `full` set is what a seal would resolve: the project's own checks plus the matrix rows' checks, produced by the
    // same resolver, so identities line up (the derivation matches on kind + command + args + cwd).
    const full: CheckCommand[] = [
        { id: 'lint', name: 'lint', kind: 'lint', command: 'make', args: ['lint'] },
        { id: 'AC-1-check', name: 'AC-1-test-node', kind: 'test', command: 'node', args: ['--test', 'alpha'], cwd: '/tmp/r' },
        { id: 'AC-2-check', name: 'AC-2-test-node', kind: 'test', command: 'node', args: ['--test', 'beta'], cwd: '/tmp/r' },
    ];

    it('maps changed paths to the acceptance rows that declare them', () => {
        expect(rowsForChangedPaths(matrix, ['src/alpha.ts']).map((entry) => entry.acceptanceId)).toEqual(['AC-1']);
        // A declared directory covers what is under it.
        expect(rowsForChangedPaths(matrix, ['tests/alpha.test.ts']).map((entry) => entry.acceptanceId)).toEqual(['AC-1']);
    });

    it('keeps only the checks the change touches, and reports what it excluded', () => {
        const result = deriveRelevantChecks({ root: '/tmp/r', matrix, changedPaths: ['src/alpha.ts'], full });

        expect(result.fellBackToFull).toBe(false);
        expect(result.acceptanceIds).toEqual(['AC-1']);
        // The declared id is the row's evidence id, which is the identity the matrix resolver stamps.
        expect(result.relevant.map((check) => check.id)).toEqual(['AC-1-check']);
        expect(result.excluded.map((check) => check.id)).toEqual(['lint', 'AC-2-check']);
    });

    it('falls back to every check when no row declares the changed path', () => {
        const result = deriveRelevantChecks({ root: '/tmp/r', matrix, changedPaths: ['docs/readme.md'], full });

        expect(result.fellBackToFull).toBe(true);
        expect(result.relevant).toEqual(full);
        expect(result.excluded).toEqual([]);
        expect(result.fallbackReason).toMatch(/no acceptance row declares/);
    });

    it('falls back when the task declares no matrix, or none was measurable', () => {
        expect(deriveRelevantChecks({ root: '/tmp/r', matrix: undefined, changedPaths: ['src/alpha.ts'], full })).toMatchObject({
            fellBackToFull: true,
            relevant: full,
        });
        expect(deriveRelevantChecks({ root: '/tmp/r', matrix, changedPaths: [], full })).toMatchObject({
            fellBackToFull: true,
            fallbackReason: 'no change surface to derive from',
        });
    });

    it('falls back when the rows for the change declare no checks at all', () => {
        const bare: AcceptanceMatrix = { version: 1, rows: [{ ...row('AC-9', ['src/alpha.ts'], [], 'node --test x'), evidence: [] }] };
        const result = deriveRelevantChecks({ root: '/tmp/r', matrix: bare, changedPaths: ['src/alpha.ts'], full });

        expect(result.fellBackToFull).toBe(true);
        expect(result.relevant).toEqual(full);
    });
});
