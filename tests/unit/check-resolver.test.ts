import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dedupeChecks, matrixChecks, matrixProjectDir, resolveCheckForRow, selectorArgs, testSelectorForRuntime } from '../../src/quality/check-resolver.js';
import type { AcceptanceMatrixRow } from '../../src/core/task.js';

/**
 * Resolving a matrix declaration to the check that runs.
 *
 * This knowledge moved out of the workflow orchestrator into a module beside the matrix model it interprets. The tests
 * therefore pin **what runs** for each shape a declaration can take — including two preserved quirks that a shell would
 * read differently, and that a move must not silently "fix".
 */
describe('matrix check resolution', () => {
    const root = '/workspace';

    function row(testPaths: string[] = ['tests/foo.test.ts']): AcceptanceMatrixRow {
        return {
            acceptanceId: 'AC-1',
            implementationPaths: ['src/foo.ts'],
            testPaths,
            evidence: [],
            verificationLevel: 'unit',
        };
    }

    it('substitutes a selector into a template and launches the runner through Node', () => {
        const check = resolveCheckForRow(
            row(),
            { kind: 'test', command: 'vitest run {{selector}}', testSelector: 'tests/foo.test.ts' },
            root,
        );

        expect(check).toMatchObject({
            id: 'matrix:AC-1:test:tests/foo.test.ts',
            source: 'matrix',
            name: 'AC-1-test-tests/foo.test.ts',
            kind: 'test',
            command: process.execPath,
            args: [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'tests/foo.test.ts'],
            cwd: root,
            timeoutMs: 120_000,
        });
    });

    it('appends a selector to a known runner', () => {
        expect(resolveCheckForRow(row(), { kind: 'test', command: 'vitest', testSelector: 'tests/foo.test.ts' }, root))
            .toMatchObject({
                command: process.execPath,
                args: [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'tests/foo.test.ts'],
            });
    });

    it('takes the plain shape for a command without a selector', () => {
        expect(resolveCheckForRow(row(), { kind: 'lint', command: 'eslint src' }, root))
            .toMatchObject({ command: 'eslint', args: ['src'], timeoutMs: 60_000 });
        // A Node-launched runner is still resolved to its entry in this shape.
        expect(resolveCheckForRow(row(), { kind: 'typecheck', command: 'tsc --noEmit' }, root))
            .toMatchObject({ command: process.execPath, args: [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit'] });
    });

    it('reports a selector for a command that cannot express one', () => {
        const resolved = resolveCheckForRow(row(), { kind: 'test', command: 'make check', testSelector: 'tests/foo.test.ts' }, root);

        expect(resolved).toBeInstanceOf(Error);
        expect((resolved as Error).message).toContain('declares a testSelector but command "make check" does not support selectors');
    });

    it('runs a `kata/`-scoped row in the nested project, rewriting the selector', () => {
        const nested = row(['kata/tests/foo.test.ts']);

        const check = resolveCheckForRow(nested, { kind: 'test', command: 'vitest run {{selector}}', testSelector: 'kata/tests/foo.test.ts' }, root);

        expect(check).toMatchObject({
            command: process.execPath,
            args: [join(root, 'kata', 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'tests/foo.test.ts'],
            cwd: join(root, 'kata'),
        });
    });

    it('preserves the two runner entries that are not a Node entry file', () => {
        // `pytest` is passed to the Node binary as its first argument on the selector path (as before), and `uv` keeps
        // its command line while the resolved command stays `uv`.
        expect(resolveCheckForRow(row(), { kind: 'test', command: 'pytest', testSelector: 'tests/foo.test.ts' }, root))
            .toMatchObject({ command: process.execPath, args: ['pytest', 'tests/foo.test.ts'] });
        expect(resolveCheckForRow(row(), { kind: 'test', command: 'uv run pytest', testSelector: 'tests/foo.test.ts' }, root))
            .toMatchObject({ command: 'uv', args: ['run', 'pytest', 'tests/foo.test.ts'] });
        // Without a selector, `pytest` is simply the command.
        expect(resolveCheckForRow(row(), { kind: 'test', command: 'pytest tests' }, root))
            .toMatchObject({ command: 'pytest', args: ['tests'] });
    });

    it('resolves a whole matrix, de-duplicating by kind, command, arguments and cwd', () => {
        const matrix = {
            version: 1 as const,
            rows: [
                { ...row(), evidence: [{ kind: 'test' as const, command: 'vitest' }, { kind: 'test' as const, command: 'vitest' }] },
                { ...row(['kata/tests/bar.test.ts']), acceptanceId: 'AC-2', evidence: [{ kind: 'test' as const, command: 'pytest tests/bar.py' }] },
            ],
        };

        const checks = matrixChecks(root, matrix);

        expect(checks).toHaveLength(2);
        expect(checks.map((check) => check.id)).toEqual(['matrix:AC-1:test:vitest', 'matrix:AC-2:test:pytest tests/bar.py']);
        // The same command in a different project directory is a different check.
        expect(dedupeChecks([checks[0]!, { ...checks[0]!, cwd: join(root, 'kata') }])).toHaveLength(2);
    });

    it('keeps the helpers that interpret a selector and a project directory', () => {
        expect(matrixProjectDir(row(), root)).toBe(root);
        expect(matrixProjectDir(row(['kata/tests/x.test.ts']), root)).toBe(join(root, 'kata'));
        expect(testSelectorForRuntime('kata/tests/x.test.ts', join(root, 'kata'), root)).toBe('tests/x.test.ts');
        expect(testSelectorForRuntime('tests/x.test.ts', root, root)).toBe('tests/x.test.ts');
        expect(selectorArgs('tests/x.test.ts -t name')).toEqual(['tests/x.test.ts', '-t', 'name']);
    });
});
