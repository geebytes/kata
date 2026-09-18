import { describe, expect, it } from 'vitest';
import { codeManifestHash, isNonCodePath, splitOwnedPaths, textOnlyChange, touchMovedCode } from '../../src/quality/code-surface.js';

/**
 * C2: a governance-text edit must not invalidate a code-verifying pass.
 *
 * Measured: three cycles in one day were pure text edits (one acceptance statement, three rewrites), each costing about an
 * hour of re-verification for roughly twenty words. The classification below is deliberately conservative, because the two
 * possible errors are not symmetric: over-classifying prose as code costs one unnecessary round, while under-classifying
 * code as prose would let a code change leave a code verdict standing.
 */
describe('code vs governance text', () => {
    it('treats documentation and governance artefacts as non-code, and everything else as code', () => {
        expect(isNonCodePath('docs/spec.md')).toBe(true);
        expect(isNonCodePath('AGENTS.md')).toBe(true);
        expect(isNonCodePath('wiki/entry.md')).toBe(true);
        expect(isNonCodePath('.llmwiki/index.md')).toBe(true);

        // Anything unrecognised is code: a configuration file can change a gate's behaviour.
        expect(isNonCodePath('src/main.py')).toBe(false);
        expect(isNonCodePath('packages/core/src/x.ts')).toBe(false);
        expect(isNonCodePath('.kata-config.json')).toBe(false);
        expect(isNonCodePath('tests/test_x.py')).toBe(false);
    });

    it('splits an owned set without losing a path', () => {
        const owned = ['src/a.py', 'docs/b.md', 'tests/c.py', 'AGENTS.md'];
        const { code, nonCode } = splitOwnedPaths(owned);
        expect(code).toEqual(['src/a.py', 'tests/c.py']);
        expect(nonCode).toEqual(['docs/b.md', 'AGENTS.md']);
        expect([...code, ...nonCode].sort()).toEqual([...owned].sort());
    });

    it('derives a code sub-manifest from the per-path digests, deterministically', () => {
        const revision = {
            ownedPaths: ['src/a.py', 'docs/b.md'],
            pathDigests: { 'src/a.py': 'hash-a', 'docs/b.md': 'hash-doc-1' },
        };
        const same = { ...revision, pathDigests: { 'src/a.py': 'hash-a', 'docs/b.md': 'hash-doc-2' } };
        expect(codeManifestHash(revision)).toBe(codeManifestHash(same));

        const codeChanged = { ...revision, pathDigests: { 'src/a.py': 'hash-b', 'docs/b.md': 'hash-doc-1' } };
        expect(codeManifestHash(revision)).not.toBe(codeManifestHash(codeChanged));
    });

    it('a text-only edit does not move code; a code edit does', () => {
        const before = { ownedPaths: ['src/a.py', 'docs/b.md'], pathDigests: { 'src/a.py': 'h1', 'docs/b.md': 'd1' } };
        const textOnly = { ownedPaths: ['src/a.py', 'docs/b.md'], pathDigests: { 'src/a.py': 'h1', 'docs/b.md': 'd2' } };
        const codeMoved = { ownedPaths: ['src/a.py', 'docs/b.md'], pathDigests: { 'src/a.py': 'h2', 'docs/b.md': 'd1' } };

        expect(touchMovedCode(before, textOnly)).toBe(false);
        expect(textOnlyChange(before, textOnly)).toBe(true);
        expect(touchMovedCode(before, codeMoved)).toBe(true);
    });

    it('falls back to "code moved" whenever it cannot classify — the safe direction', () => {
        // No per-path digests (a revision sealed before F2): cannot say, so the code counts as unverified.
        const legacy = { ownedPaths: ['src/a.py'], pathDigests: undefined } as unknown as { ownedPaths: string[]; pathDigests?: Record<string, string> };
        const current = { ownedPaths: ['src/a.py'], pathDigests: { 'src/a.py': 'h1' } };
        expect(touchMovedCode(legacy, current)).toBe(true);
        // No code paths at all: same answer, because there is nothing whose verdict could stand.
        const docsOnly = { ownedPaths: ['docs/a.md'], pathDigests: { 'docs/a.md': 'd1' } };
        expect(touchMovedCode(null, docsOnly)).toBe(true);
    });
});
