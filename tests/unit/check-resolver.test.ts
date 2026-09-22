import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dedupeChecks, matrixChecks, matrixProjectDir, resolveCheckForRow, sanitizeCheckName, selectorArgs, testSelectorForRuntime } from '../../src/quality/check-resolver.js';
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
            name: 'AC-1-test-tests-foo.test.ts',
            kind: 'test',
            command: process.execPath,
            args: [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'tests/foo.test.ts'],
            cwd: root,
            timeoutMs: 120_000,
        });
    });

    it('appends a selector to a known runner', () => {
        // `run` is not decoration: `vitest.mjs` with no subcommand starts watch mode, so the resolved check never
        // returned and every matrix test check timed out. See `tests/unit/matrix-runner-subcommand.test.ts`.
        expect(resolveCheckForRow(row(), { kind: 'test', command: 'vitest', testSelector: 'tests/foo.test.ts' }, root))
            .toMatchObject({
                command: process.execPath,
                args: [join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'tests/foo.test.ts'],
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
    it('names a matrix-derived check so its own evidence schema accepts it', () => {
        // 回归：name 曾直接嵌入命令行（含空格/斜杠），而 evidence.schema.json 约束
        // name 为 ^[A-Za-z0-9_.-]+$，于是 seal 会因为证据对自己的 schema 不合法而失败。
        const checks = matrixChecks(root, {
            version: 1,
            rows: [
                {
                    acceptanceId: 'AC-7',
                    implementationPaths: ['src/foo.ts'],
                    testPaths: ['tests/foo.test.ts'],
                    evidence: [
                        { kind: 'test', command: 'uv run pytest tests/foo.test.ts -q' },
                        { kind: 'integration', command: 'uv run pytest', testSelector: 'tests/a/b_test.py' },
                    ],
                    verificationLevel: 'integration',
                },
            ],
        });

        expect(checks).toHaveLength(2);
        for (const check of checks) {
            expect(check.name).toMatch(/^[A-Za-z0-9_.-]+$/);
        }
    });

    it('keeps a usable name when a command sanitizes to nothing', () => {
        // 全非法字符的命令行：清洗后为空 ⇒ 回退到「验收项-种类」，而不是产出空名字。
        const checks = matrixChecks(root, {
            version: 1,
            rows: [
                {
                    acceptanceId: 'AC-8',
                    implementationPaths: ['src/foo.ts'],
                    testPaths: ['tests/foo.test.ts'],
                    evidence: [{ kind: 'test', command: '///' }],
                    verificationLevel: 'unit',
                },
            ],
        });

        const name = checks[0]?.name ?? '';
        expect(name).toMatch(/^[A-Za-z0-9_.-]+$/);
        expect(name.length).toBeGreaterThan(0);
    });

    it('shares one sanitizer with the artefact filename', () => {
        expect(sanitizeCheckName('AC-1-test-uv run pytest tests/x.py -q')).toBe(
            'AC-1-test-uv-run-pytest-tests-x.py--q',
        );
        expect(sanitizeCheckName('--')).toBe('');
    });

    it('resolves the runner entry through dependency resolution, not through the project directory literal', async () => {
        // A linked worktree deliberately has no `node_modules` of its own: Node resolves dependencies from an ancestor
        // workspace, and the seal's execution sandbox copies from those ancestor candidates for the same reason. The
        // runner entry was built as `join(projectDir, 'node_modules', …)`, so in a worktree every matrix check died with
        // MODULE_NOT_FOUND on a path that does not exist there — all seven declared checks in one seal run.
        const { mkdir: mk, mkdtemp, rm, writeFile: wf } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { basename } = await import('node:path');
        const parent = await mkdtemp(join(tmpdir(), 'kata-runner-entry-'));
        const worktree = join(parent, 'wt');
        const ancestor = join(parent, 'ancestor');
        try {
            // The worktree: sources only, no dependencies.
            await mk(join(worktree, 'tests'), { recursive: true });
            await wf(join(worktree, 'package.json'), JSON.stringify({ name: 'wt', version: '1.0.0' }), 'utf8');
            // The ancestor workspace: where the dependency actually resolves from.
            await mk(join(ancestor, 'node_modules', 'vitest'), { recursive: true });
            await wf(join(ancestor, 'node_modules', 'vitest', 'vitest.mjs'), '// vitest entry\n', 'utf8');

            const check = resolveCheckForRow(row(), { kind: 'test', command: 'vitest', testSelector: 'tests/foo.test.ts' }, worktree, { dependencyRoots: [ancestor] });
            if (check instanceof Error) throw check;
            // Runnable, and located where the dependency does — not at the worktree literal.
            expect(check.args?.[0]).toBe(join(ancestor, 'node_modules', 'vitest', 'vitest.mjs'));
            expect(basename(check.args?.[0] ?? '')).toBe('vitest.mjs');
        } finally {
            await rm(parent, { recursive: true, force: true });
        }
    });
})
;
