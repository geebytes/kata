import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    ignoredDirectoryNames,
    isIgnoredRepositoryName,
    isIgnoredRepositoryPath,
    maxTreeHashFileBytes,
    repositoryTreeHash,
    walkRepositoryFiles,
} from '../../src/core/repository-identity.js';
import { computeManifestHash, workspaceDrift } from '../../src/workflow/revision.js';

/**
 * Repository identity had three answers — the freshness hash's ignore table, the revision manifest's copy, and a
 * differently scoped table for drift — so they could disagree about a path. These tests pin the one policy and the
 * consequences of sharing it, including the one deliberate difference (the tree hash's size budget).
 */
describe('repository identity', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function tempRoot(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-identity-'));
        roots.push(root);
        return root;
    }

    it('excludes caches, kata state and generated trees by name or path', () => {
        for (const name of ['.git', '.kata', '.llmwiki', '.pytest_cache', '.mypy_cache', '.ruff_cache', '__pycache__', 'node_modules', 'dist']) {
            expect(isIgnoredRepositoryName(name)).toBe(true);
            expect(isIgnoredRepositoryPath(`nested/${name}/file.txt`)).toBe(true);
        }
        expect(isIgnoredRepositoryPath('.github/hooks/state.json')).toBe(true);
        expect(isIgnoredRepositoryPath('.github/skills/README.md')).toBe(true);
        expect(isIgnoredRepositoryPath('.models/weights.gguf')).toBe(true);
        expect(isIgnoredRepositoryName('weights.safetensors')).toBe(true);
        expect(isIgnoredRepositoryPath('src/core/state.ts')).toBe(false);
        expect(isIgnoredRepositoryPath('docs/.pytest_cache.md')).toBe(false);
    });

    it('is the same policy for the tree hash and for drift', async () => {
        const root = await tempRoot();
        execFileSync('git', ['init', '-q', '.'], { cwd: root });
        execFileSync('git', ['config', 'user.email', 'kata@example.com'], { cwd: root });
        execFileSync('git', ['config', 'user.name', 'Kata'], { cwd: root });
        await writeFile(join(root, 'subject.ts'), 'export const version = 1;\n', 'utf8');
        await mkdir(join(root, '.pytest_cache'), { recursive: true });
        await writeFile(join(root, '.pytest_cache', 'state.json'), '{}\n', 'utf8');
        execFileSync('git', ['add', '-A'], { cwd: root });
        execFileSync('git', ['commit', '-qm', 'initial'], { cwd: root });

        // A cache directory churns: the tree hash ignores it and drift does not report it.
        await writeFile(join(root, '.pytest_cache', 'state.json'), '{"run": 2}\n', 'utf8');
        const hashWithCacheChurn = await repositoryTreeHash(root);
        expect(await workspaceDrift(root, [])).toEqual([]);

        // An ordinary file changes: both notice.
        await writeFile(join(root, 'subject.ts'), 'export const version = 2;\n', 'utf8');
        expect(await repositoryTreeHash(root)).not.toBe(hashWithCacheChurn);
        expect(await workspaceDrift(root, [])).toEqual(['subject.ts']);
    });

    it('restricts a walk to a subtree and returns repository-relative paths', async () => {
        const root = await tempRoot();
        await mkdir(join(root, 'pkg/sub'), { recursive: true });
        await writeFile(join(root, 'pkg/sub/one.txt'), 'one\n', 'utf8');
        await writeFile(join(root, 'pkg/two.txt'), 'two\n', 'utf8');
        await writeFile(join(root, 'outside.txt'), 'outside\n', 'utf8');

        expect((await walkRepositoryFiles(root, { under: 'pkg' })).map((file) => file.path)).toEqual(['pkg/sub/one.txt', 'pkg/two.txt']);
        expect((await walkRepositoryFiles(root)).map((file) => file.path)).toEqual(['outside.txt', 'pkg/sub/one.txt', 'pkg/two.txt']);
        expect(await walkRepositoryFiles(root, { under: '.kata' })).toEqual([]);
    });

    it('caps the tree hash by size but hashes owned paths in full', async () => {
        const root = await tempRoot();
        await mkdir(join(root, 'owned'), { recursive: true });
        const large = 'x'.repeat(maxTreeHashFileBytes + 1);
        await writeFile(join(root, 'owned/large.txt'), large, 'utf8');
        await writeFile(join(root, 'owned/small.txt'), 'small\n', 'utf8');

        // The tree hash is a cheap fingerprint: it does not read a file that is excluded by size.
        expect((await walkRepositoryFiles(root, { maxFileBytes: maxTreeHashFileBytes })).map((file) => file.path)).toEqual(['owned/small.txt']);
        // The manifest is responsible for every owned file: a change to the large one must still change the identity.
        const before = await computeManifestHash(root, ['owned']);
        await writeFile(join(root, 'owned/large.txt'), `${large}y`, 'utf8');
        expect(await computeManifestHash(root, ['owned'])).not.toBe(before);
    });

    it('keeps the documented directory list exported, so a new exclusion is a deliberate edit', () => {
        expect(ignoredDirectoryNames).toEqual(expect.arrayContaining(['.git', '.kata', 'node_modules']));
        expect(ignoredDirectoryNames.length).toBeGreaterThan(5);
    });
});
