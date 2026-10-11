import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checksForExecutionSandbox } from '../../src/workflow/execution-sandbox.js';

/**
 * **The positive control.** A fix for "a longer name is not a reference" must not degenerate into "never rewrite": a value that
 * *is* the author root, or references it as a path segment, is still mapped into the snapshot — otherwise a check would run
 * against the author tree from inside the sandbox, which is the isolation this layer exists to provide.
 *
 * The rule is the **path segment**, so an occurrence embedded inside a longer value is mapped when it is followed by a
 * separator (`…file='<root>/second-started'…` inside a script argument) and left alone when it is not (`<root>backup`). Both
 * halves are asserted here because both are load-bearing: the seal's own tests pass a witness path through a script argument,
 * and dropping that half would break the isolation they rely on.
 */
describe('an argument that references the repository is rewritten', () => {
    const authorRoot = join(tmpdir(), 'kata-author-root-fixture');
    const sandboxRoot = join(tmpdir(), 'kata-seal-execution-fixture');

    it('maps the root itself, the root with a trailing separator, and paths under it', () => {
        const execution = checksForExecutionSandbox([
            { kind: 'test', command: `${authorRoot}/.venv/bin/ruff`, args: [authorRoot, `${authorRoot}/`, `${authorRoot}/tests/support`], cwd: authorRoot },
        ], authorRoot, sandboxRoot)[0].execution;

        expect(execution?.command).toBe(`${sandboxRoot}/.venv/bin/ruff`);
        expect(execution?.args).toEqual([sandboxRoot, `${sandboxRoot}/`, `${sandboxRoot}/tests/support`]);
    });

    it('maps an occurrence embedded in a longer value when it is a path segment', () => {
        const script = `require('fs').writeFileSync('${authorRoot}/second-started','yes')`;
        const execution = checksForExecutionSandbox([
            { kind: 'test', command: 'node', args: ['-e', script], cwd: authorRoot },
        ], authorRoot, sandboxRoot)[0].execution;

        expect(execution?.args?.[1]).toBe(`require('fs').writeFileSync('${sandboxRoot}/second-started','yes')`);
    });

    it('maps cwd through the same question, so a check under a subdirectory still runs there', () => {
        const execution = checksForExecutionSandbox([
            { kind: 'test', command: 'node', args: [], cwd: `${authorRoot}/packages/x` },
        ], authorRoot, sandboxRoot)[0].execution;

        expect(execution?.cwd).toBe(`${sandboxRoot}/packages/x`);
    });

    it('leaves a relative value alone, because a relative value is not a repository reference', () => {
        const execution = checksForExecutionSandbox([
            { kind: 'test', command: 'node', args: ['src:application'], cwd: authorRoot },
        ], authorRoot, sandboxRoot)[0].execution;

        expect(execution?.args).toEqual(['src:application']);
    });

    it('leaves an absolute path outside the repository alone', () => {
        const execution = checksForExecutionSandbox([
            { kind: 'test', command: 'node', args: ['/usr/bin/env', '/etc/hosts'], cwd: authorRoot },
        ], authorRoot, sandboxRoot)[0].execution;

        expect(execution?.args).toEqual(['/usr/bin/env', '/etc/hosts']);
    });
});
