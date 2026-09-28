import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli.js';
import { readTask } from '../../src/core/task.js';
import { initLayout } from '../../src/core/layout.js';
import { argValue } from '../../src/cli/invocation.js';

/**
 * **A documented flag must be read, and the read must not swallow the next flag.**
 *
 * `kata-cli open --title <text>` was in the usage text and no code path read it: the title came from
 * `openRequirements[0]?.statement` or a `Change <id>` fallback, so a `--title` passed by an operator was dropped silently
 * and the task was persisted with a name nobody chose. `hotfix` and `tweak` carried the same fallback. The flag is
 * honoured now, because it is the only way to name a task whose requirements file is absent or whose first statement is
 * not a title.
 *
 * Two properties, and the second is why the third copy of the helper had to go:
 *
 * 1. the flag reaches the record;
 * 2. **`--title --isolation git_flow` does not set the title to `"--isolation"`** — there were three `valueAfter`
 *    implementations, and two of them returned the next token whatever it was, so a title could swallow the flag that
 *    followed it and the run would then fail for a missing profile choice.
 */
const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('a documented flag has a reader', () => {
    it('uses --title as the task’s name', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-title-'));
        roots.push(root);
        await initLayout(root);

        await main(['open', 'titled-task', '--isolation', 'current_worktree', '--development', 'tdd', '--review', 'std', '--title', 'A name the operator chose', '--root', root, '--quiet']);

        await expect(readTask(root, 'titled-task')).resolves.toMatchObject({ title: 'A name the operator chose' });
    });

    it('falls back when no title is given, so the flag is optional', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-title-fallback-'));
        roots.push(root);
        await initLayout(root);

        await main(['open', 'untitled-task', '--isolation', 'current_worktree', '--development', 'tdd', '--review', 'std', '--root', root, '--quiet']);

        await expect(readTask(root, 'untitled-task')).resolves.toMatchObject({ title: 'Change untitled-task' });
    });

    it('does not read the next flag as the value', async () => {
        // The three copies disagreed about this, which is how the same invocation could behave two ways depending on which
        // command handled it. A token starting with `--` is a flag, not a value — the rule `parseChangeArg` already used.
        expect(argValue(['--title', '--isolation', 'git_flow'], '--title')).toBeUndefined();
        expect(argValue(['--title', 'A real title'], '--title')).toBe('A real title');
        expect(argValue(['--title'], '--title')).toBeUndefined();
        expect(argValue([], '--title')).toBeUndefined();
        expect(argValue(['--other', 'x', '--title', 'y'], '--title')).toBe('y');
    });
});
