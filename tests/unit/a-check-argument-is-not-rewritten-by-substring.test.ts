import { describe, expect, it } from 'vitest';
import { checksForExecutionSandbox } from '../../src/workflow/execution-sandbox.js';

/**
 * **A substring that contains the root is not a reference to it.**
 *
 * `rewriteAuthorReference` used to be `value.replaceAll(authorRoot, sandboxRoot)`, so with the author root `/app` the argument
 * `tests/application` reached the command as `tests/tmp/kata-seal-execution-XXXXlication` — the argument the check declared
 * was not the argument the sandbox ran, and the corruption showed up only in the log
 * (`docs/superpowers/reports/2026-10-10-workspace-root-substitution-corrupts-check-arguments.md`, reproduced independently
 * before this change: `packages/x/src/x/application` → `packages/x/src/x/tmp/kata-seal-execution-XXXXlication`).
 */
describe('a check argument is not rewritten by substring', () => {
    const authorRoot = '/app';
    const sandboxRoot = '/tmp/kata-seal-execution-AAAAAA';

    const executionOf = (check: Parameters<typeof checksForExecutionSandbox>[0][number]) =>
        checksForExecutionSandbox([check], authorRoot, sandboxRoot)[0].execution;

    it('leaves an argument that merely contains the root untouched', () => {
        const execution = executionOf({
            kind: 'test',
            command: 'node',
            args: ['tests/application', 'packages/x/src/x/application', 'application'],
            cwd: authorRoot,
        });
        expect(execution?.args).toEqual(['tests/application', 'packages/x/src/x/application', 'application']);
    });

    it('leaves a command that merely contains the root untouched', () => {
        const execution = executionOf({ kind: 'test', command: './bin/application', args: [], cwd: authorRoot });
        expect(execution?.command).toBe('./bin/application');
    });

    it('leaves an env value that merely contains the root untouched', () => {
        const execution = executionOf({ kind: 'test', command: 'node', args: [], cwd: authorRoot, env: { APP_TARGET: 'tests/application' } });
        expect(execution?.env).toEqual({ APP_TARGET: 'tests/application' });
    });

    it('leaves a value that embeds the root but does not begin with it untouched', () => {
        // **A deliberate boundary, not an omission.** `--flag=/app/x` is no longer rewritten: an unreplaced absolute path is a
        // loud failure (it does not exist in the sandbox, so the check fails with the value in its log), while a guessed rewrite
        // is a silent wrong answer. This assertion states that choice where the behaviour lives.
        const execution = executionOf({ kind: 'test', command: 'node', args: ['--root=/app/src'], cwd: authorRoot });
        expect(execution?.args).toEqual(['--root=/app/src']);
    });
});
