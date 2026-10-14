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

    it('leaves a value whose root occurrence continues into a longer name written in another script', () => {
        // **The boundary class was ASCII, so a longer name written in another script looked like a separator.** An
        // independent round measured a value with `é` / `据` in front of the root: `/[A-Za-z0-9._-]/u` answers false for
        // both, the occurrence was judged to begin a path segment, and a longer *name* was rewritten into the sandbox. The
        // declared boundary is "the preceding character does not continue a name", and a name is not ASCII.
        const execution = executionOf({
            kind: 'test',
            command: 'node',
            // **And a name character is not one UTF-16 unit either.** The second round that touched this boundary measured the
            // astral case: `\u{10400}` is *two* units, `value[at - 1]` is its trailing surrogate, and a class written over
            // *characters* answers `false` for a lone surrogate — so the name `\u{10400}` + root was rewritten too. A code
            // point that spans two units is still one name character.
            args: [`é${authorRoot}/x`, `数据${authorRoot}/x`, `\u{10400}${authorRoot}/x`],
            cwd: authorRoot,
        });
        expect(execution?.args).toEqual([`é${authorRoot}/x`, `数据${authorRoot}/x`, `\u{10400}${authorRoot}/x`]);
    });
});
