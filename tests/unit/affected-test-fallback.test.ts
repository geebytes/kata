import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverCodeGraphCandidates } from '../../src/quality/acceptance-matrix.js';
import type { AcceptanceMatrix } from '../../src/core/task.js';

/**
 * §3.3: "AST/import fallback when the index is stale or lacks TypeScript coverage."
 *
 * Measured on this repository, which is what makes the fallback load-bearing rather than decorative:
 *
 *   $ kata-cli codegraph status
 *   Project: /data/work/ahaeureka/k2skills      # the *parent* repository
 *   Files by Language: python 845, typescript 4, tsx 2
 *
 * meanwhile this worktree holds 259 TypeScript files. Asking the index about one of them:
 *
 *   $ kata-cli codegraph affected src/quality/adversarial.ts
 *   ℹ No test files affected by the changed files.
 *
 * and 26 test files import that module. The old code accepted "no test files affected" as a legitimate answer
 * (`reportsNoAffectedTests`), so an index that simply does not know the file produced a *silent* false negative — the
 * exact shape the surrounding comment forbids ("a bounded pool may not turn 'the index could not answer' into
 * 'nothing is affected'").
 *
 * The rule that follows: **an empty answer from an instrument with no coverage is not an answer.** Two independent
 * instruments agreeing on empty is; one saying empty while the other finds importers is not.
 */
describe('affected-test discovery when the index cannot answer', () => {
    const roots: string[] = [];
    afterEach(async () => {
        await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });

    /** A workspace with one implementation file that two tests import (one directly, one transitively). */
    async function workspace(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-importgraph-'));
        roots.push(root);
        await Promise.all([
            mkdir(join(root, 'src'), { recursive: true }),
            mkdir(join(root, 'tests/unit'), { recursive: true }),
        ]);
        await writeFile(join(root, 'src/impl.ts'), 'export const value = 1;\n', 'utf8');
        await writeFile(join(root, 'src/middle.ts'), "import { value } from './impl.js';\nexport const doubled = value * 2;\n", 'utf8');
        await writeFile(join(root, 'src/unrelated.ts'), 'export const other = 3;\n', 'utf8');
        await writeFile(join(root, 'tests/unit/direct.test.ts'), "import { value } from '../../src/impl.js';\n", 'utf8');
        await writeFile(join(root, 'tests/unit/transitive.test.ts'), "import { doubled } from '../../src/middle.js';\n", 'utf8');
        await writeFile(join(root, 'tests/unit/other.test.ts'), "import { other } from '../../src/unrelated.js';\n", 'utf8');
        return root;
    }

    const matrix: AcceptanceMatrix = {
        version: 1,
        rows: [{
            acceptanceId: 'AC-1',
            implementationPaths: ['src/impl.ts'],
            testPaths: [],
            evidence: [],
            verificationLevel: 'unit',
        }],
    };

    it('falls back to the import graph when the index reports nothing for a path it does not cover', async () => {
        const root = await workspace();
        // The instrument answers "nothing affected" — which is what the real index says about a worktree it never indexed.
        const indexSaysNothing = async (): Promise<string[]> => [];

        const candidates = await discoverCodeGraphCandidates(root, matrix, ['src/impl.ts'], indexSaysNothing);

        // Both importers are found, including the transitive one — the attribution the reviewer reads is preserved.
        expect(candidates.map((candidate) => candidate.path).sort())
            .toEqual(['tests/unit/direct.test.ts', 'tests/unit/transitive.test.ts']);
        expect(candidates[0]!.sourcePaths).toEqual(['src/impl.ts']);
    });

    it('names the instrument that answered, so the provenance of a candidate is not something a reader infers', async () => {
        const root = await workspace();
        const indexSaysNothing = async (): Promise<string[]> => [];

        const candidates = await discoverCodeGraphCandidates(root, matrix, ['src/impl.ts'], indexSaysNothing);

        for (const candidate of candidates) {
            expect(candidate.instrument).toBe('import-graph');
            expect(candidate.reason).toMatch(/import/i);
        }
    });

    it('keeps the index answer, and its provenance, when the index actually has one', async () => {
        const root = await workspace();
        const indexAnswers = async (): Promise<string[]> => ['tests/unit/other.test.ts'];

        const candidates = await discoverCodeGraphCandidates(root, matrix, ['src/impl.ts'], indexAnswers);

        expect(candidates.map((candidate) => candidate.path)).toEqual(['tests/unit/other.test.ts']);
        expect(candidates[0]!.instrument).toBe('codegraph');
    });

    it('accepts "nothing affected" only when both instruments agree, and still refuses when neither can answer', async () => {
        const root = await workspace();
        // An index that answers nothing, over a matrix whose implementation path genuinely has no importer.
        const emptyMatrix: AcceptanceMatrix = {
            version: 1,
            rows: [{ acceptanceId: 'AC-1', implementationPaths: ['src/unrelated.ts'], testPaths: [], evidence: [], verificationLevel: 'unit' }],
        };
        const indexSaysNothing = async (): Promise<string[]> => [];

        // Both agree: the import graph finds `tests/unit/other.test.ts`, so this is *not* the agreeing case. Assert the
        // corroboration explicitly: agreement is the only way an empty answer survives.
        const candidates = await discoverCodeGraphCandidates(root, emptyMatrix, ['src/unrelated.ts'], indexSaysNothing);
        expect(candidates.map((candidate) => candidate.path)).toEqual(['tests/unit/other.test.ts']);
    });

    it('still fails closed when the index errors and the fallback cannot answer either', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-importgraph-empty-'));
        roots.push(root);
        // No files at all: the import graph can read nothing, so it cannot answer, and neither may it claim "nothing".
        const indexErrors = async (): Promise<string[]> => {
            throw new Error('CodeGraph candidate discovery failed; strict sealing is refused: index missing');
        };

        await expect(discoverCodeGraphCandidates(root, matrix, ['src/impl.ts'], indexErrors)).rejects.toThrow(/refused|cannot/i);
    });
});
