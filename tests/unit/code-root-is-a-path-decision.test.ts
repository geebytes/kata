import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveCodeRoot, recordsRoot } from '../../src/core/layout.js';

/**
 * **AC-2: the code root is a separate decision, and the CLI makes it.**
 *
 * `resolveCodeRoot` was written and never called: the only root decision point in the CLI still asked the *record*
 * resolver, so a workflow command run from inside a linked worktree received the **primary checkout** as its root — and
 * `cmdBuild` hands that root to `createExecutionSandbox`, which copies the author root's content into the sandbox. The
 * code the command built was therefore the primary checkout's code, and `isolated_worktree` was not in effect on the CLI
 * path while the criterion claimed the split existed.
 *
 * The case drives the CLI's own decision function rather than the resolver, because a test that calls the resolver cannot
 * see a decision point that does not call it — which is exactly the defect.
 */
function fixture(): { primary: string; worktree: string } {
    const primary = mkdtempSync(join(tmpdir(), 'kata-code-root-'));
    writeFileSync(join(primary, 'package.json'), '{ "name": "fixture", "private": true }\n');
    // A linked worktree as `git worktree add` lays one out: `.git` is a file pointing at the real gitdir.
    const worktree = join(primary, '.kata', 'worktrees', 'code-root-task');
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(primary, '.git', 'worktrees', 'code-root-task')}\n`);
    mkdirSync(join(primary, '.kata', 'tasks', 'code-root-task'), { recursive: true });
    writeFileSync(
        join(primary, '.kata', 'tasks', 'code-root-task', 'current-state.json'),
        `${JSON.stringify({ taskId: 'code-root-task', phase: 'intake' })}\n`,
    );
    execFileSync('git', ['init', '-q'], { cwd: primary });
    return { primary, worktree };
}

describe('the code root is decided by the path, not by a record', () => {
    it('returns the linked worktree a caller stands in, with no .kata/ content there at all', () => {
        const { primary, worktree } = fixture();
        // The fixture deliberately writes no `.kata/` file inside the worktree: this is the state the copy-in used to
        // paper over, and the one in which the record resolver falls back to the primary checkout.
        expect(resolveCodeRoot(join(worktree, 'src', 'deep'))).toBe(worktree);
        rmSync(primary, { recursive: true, force: true });
    });

    it('answers the other question than the record root, from the same directory', () => {
        const { primary, worktree } = fixture();
        // Both are true at once, and they name different checkouts. That is the whole point of the split.
        expect(recordsRoot(join(worktree, 'src'), 'code-root-task')).toBe(primary);
        expect(resolveCodeRoot(join(worktree, 'src'))).toBe(worktree);
        rmSync(primary, { recursive: true, force: true });
    });

    it('the command root for a task-addressed command is the code root, not the record root', async () => {
        const { primary, worktree } = fixture();
        const { resolveCommandRoot } = await import('../../src/cli.js');
        const here = process.cwd();
        try {
            mkdirSync(join(worktree, 'src'), { recursive: true });
            process.chdir(join(worktree, 'src'));
            // A task-addressed workflow command: the code it operates on is the checkout the caller stands in.
            expect(resolveCommandRoot('build', 'code-root-task')).toBe(worktree);
            // And the record resolver still names the owner, so the two questions have not been collapsed the other way.
            expect(recordsRoot(process.cwd(), 'code-root-task')).toBe(primary);
        } finally {
            process.chdir(here);
            rmSync(primary, { recursive: true, force: true });
        }
    });
});
