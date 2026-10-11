import { describe, expect, it } from 'vitest';
import { checksForExecutionSandbox } from '../../src/workflow/execution-sandbox.js';

/**
 * **The positive control.** A fix for "a substring is not a reference" must not degenerate into "never rewrite": a value that
 * *is* the author root, or that begins with the root as a path segment, is still mapped into the sandbox — otherwise the check
 * would run against the author tree from inside the sandbox, which is the isolation this layer exists to provide.
 */
describe('a check argument that points inside the repository is rewritten', () => {
    const authorRoot = '/app';
    const sandboxRoot = '/tmp/kata-seal-execution-AAAAAA';

    it('maps the root itself, the root with a trailing slash, and paths under it', () => {
        const execution = checksForExecutionSandbox([
            { kind: 'test', command: '/app/.venv/bin/ruff', args: ['/app', '/app/', '/app/tests/support'], cwd: authorRoot },
        ], authorRoot, sandboxRoot)[0].execution;

        expect(execution?.command).toBe(`${sandboxRoot}/.venv/bin/ruff`);
        expect(execution?.args).toEqual([sandboxRoot, sandboxRoot, `${sandboxRoot}/tests/support`]);
    });

    it('maps cwd through the same question, so a check under a subdirectory still runs there', () => {
        const execution = checksForExecutionSandbox([
            { kind: 'test', command: 'node', args: [], cwd: '/app/packages/x' },
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
