import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { uniqueCopies, UniqueCopiesUndetermined } from '../../src/core/layout.js';

/**
 * AC-4 — a source that cannot answer is not an empty answer.
 *
 * The measured defect (reading 1, F9): `gitWorktreeList` returned `[]` when it failed, and the enumeration kept only
 * candidates inside the root. Both failure directions produced an **empty set**, and an empty set is exactly the answer
 * that means "nothing would be lost" — so archive could not tell "there is nothing to remove" from "I could not look",
 * and it removed the worktree holding the only copy.
 *
 * The criterion is the distinction, not the mechanism: an unreadable source raises.
 */
const roots: string[] = [];

function repo(name: string): string {
    const root = mkdtempSync(join(tmpdir(), `kata-uc-undet-${name}-`));
    roots.push(root);
    writeFileSync(join(root, 'package.json'), '{ "name": "uc", "private": true }\n');
    execFileSync('git', ['init', '-q'], { cwd: root });
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) {
        // A case may have removed read permission; restore it so the cleanup can run.
        try {
            chmodSync(join(root, '.kata', 'worktrees'), 0o755);
        } catch {
            // Nothing to restore.
        }
        rmSync(root, { recursive: true, force: true });
    }
});

describe('cannot determine is not empty', () => {
    it('raises when the worktrees directory cannot be read', async () => {
        const primary = repo('unreadable');
        const worktrees = join(primary, '.kata', 'worktrees');
        mkdirSync(worktrees, { recursive: true });
        chmodSync(worktrees, 0o000);

        await expect(uniqueCopies({ root: primary })).rejects.toBeInstanceOf(UniqueCopiesUndetermined);
    });

    it('answers normally when there are no worktrees at all', async () => {
        // The other direction: a repository that never isolated has nothing to lose, and that must stay a plain empty
        // answer rather than an error — otherwise every archive on a clean change would refuse.
        const primary = repo('none');
        expect(await uniqueCopies({ root: primary })).toEqual([]);
    });

    it('names what it could not determine', async () => {
        const primary = repo('named');
        const worktrees = join(primary, '.kata', 'worktrees');
        mkdirSync(worktrees, { recursive: true });
        chmodSync(worktrees, 0o000);

        await expect(uniqueCopies({ root: primary })).rejects.toThrow(/could not be determined/u);
    });
});
