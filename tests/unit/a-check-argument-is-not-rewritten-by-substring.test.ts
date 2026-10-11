import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checksForExecutionSandbox } from '../../src/workflow/execution-sandbox.js';

/**
 * **A longer name that contains the root is not a reference to the root.**
 *
 * `rewriteAuthorReference` used to be `value.replaceAll(authorRoot, sandboxRoot)`, so with the author root `/app` the argument
 * `tests/application` reached the command as `tests/tmp/kata-seal-execution-XXXXlication`: the argument the check declared was
 * not the argument the sandbox ran, and the corruption showed up only in the log
 * (`docs/superpowers/reports/2026-10-10-workspace-root-substitution-corrupts-check-arguments.md`, reproduced independently:
 * `packages/x/src/x/application` → `packages/x/src/x/tmp/kata-seal-execution-XXXXlication`).
 *
 * The property is a **path segment**, and the fixture builds its roots at run time for that reason: the shape under test is
 * "the root, immediately followed by a character that is not a separator" — `tests/application` when the root is `/app` — which
 * a literal root in the source could only express by hard-coding one checkout's path.
 */
describe('an argument that merely contains the root is not rewritten', () => {
    const authorRoot = join(tmpdir(), 'kata-author-root-fixture');
    const sandboxRoot = join(tmpdir(), 'kata-seal-execution-fixture');

    const executionOf = (check: Parameters<typeof checksForExecutionSandbox>[0][number]) =>
        checksForExecutionSandbox([check], authorRoot, sandboxRoot)[0].execution;

    it('leaves an argument whose root occurrence continues into a longer name', () => {
        const execution = executionOf({
            kind: 'test',
            command: 'node',
            args: [`${authorRoot}backup`, `dir/${authorRoot}backup/application`, 'tests/application'],
            cwd: authorRoot,
        });
        expect(execution?.args).toEqual([`${authorRoot}backup`, `dir/${authorRoot}backup/application`, 'tests/application']);
    });

    it('leaves a command that contains the root without ending at a separator', () => {
        const execution = executionOf({ kind: 'test', command: `./bin/${authorRoot}tool`, args: [], cwd: authorRoot });
        expect(execution?.command).toBe(`./bin/${authorRoot}tool`);
    });

    it('leaves an env value whose root occurrence continues into a longer name', () => {
        const execution = executionOf({
            kind: 'test', command: 'node', args: [], cwd: authorRoot, env: { APP_TARGET: `${authorRoot}cache` },
        });
        expect(execution?.env).toEqual({ APP_TARGET: `${authorRoot}cache` });
    });

    it('leaves a value that does not mention the root at all', () => {
        const execution = executionOf({ kind: 'test', command: 'node', args: ['--watch', 'src/app.ts'], cwd: authorRoot });
        expect(execution?.args).toEqual(['--watch', 'src/app.ts']);
    });
});
