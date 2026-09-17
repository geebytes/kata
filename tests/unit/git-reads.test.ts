import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { changedGitPaths, currentGitBranch, currentGitHead, isGitRepository, readGitValue, runGit } from '../../src/core/git.js';

/**
 * `core/git.ts` is the one reader of repository state: the lifecycle's branch, head and changed-path facts come from
 * here, so that a consumer cannot end up with a different view of the repository than the one it was sealed against.
 */
describe('repository reads', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function repo(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-git-'));
        roots.push(root);
        execFileSync('git', ['init', '-q', '-b', 'main', '.'], { cwd: root });
        execFileSync('git', ['config', 'user.email', 'kata@example.com'], { cwd: root });
        execFileSync('git', ['config', 'user.name', 'Kata'], { cwd: root });
        await writeFile(join(root, 'tracked.txt'), 'one\n', 'utf8');
        execFileSync('git', ['add', '-A'], { cwd: root });
        execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });
        return root;
    }

    it('reads the branch and head, and reports failure instead of throwing', async () => {
        const root = await repo();

        expect(currentGitBranch(root)).toBe('main');
        expect(currentGitHead(root)).toMatch(/^[0-9a-f]{40}$/);
        expect(isGitRepository(root)).toBe(true);

        const notARepository = await mkdtemp(join(tmpdir(), 'kata-git-none-'));
        roots.push(notARepository);
        expect(currentGitBranch(notARepository)).toBeNull();
        expect(currentGitHead(notARepository)).toBeNull();
        expect(isGitRepository(notARepository)).toBe(false);
        expect(readGitValue(notARepository, ['rev-parse', 'HEAD'])).toBeNull();
        expect(runGit(notARepository, ['status'])).toMatchObject({ ok: false });
    });

    it('reports changed, untracked and renamed paths', async () => {
        const root = await repo();

        expect(changedGitPaths(root)).toEqual([]);

        await writeFile(join(root, 'tracked.txt'), 'two\n', 'utf8');
        await writeFile(join(root, 'untracked.txt'), 'new\n', 'utf8');
        expect(changedGitPaths(root).sort()).toEqual(['tracked.txt', 'untracked.txt']);

        execFileSync('git', ['mv', 'tracked.txt', 'renamed.txt'], { cwd: root });
        // A rename touches two paths, and both are reported: the destination and the source it came from.
        expect(changedGitPaths(root).sort()).toEqual(['renamed.txt', 'tracked.txt', 'untracked.txt']);
    });
});
