import { describe, expect, it } from 'vitest';
import { codeManifestHash, isNonCodePath, touchMovedCode } from '../../src/quality/code-surface.js';

/**
 * C2: a governance-text edit must not invalidate a code-verifying pass.
 *
 * Measured: three cycles in one day were pure text edits (one acceptance statement, three rewrites), each costing about an
 * hour of re-verification for roughly twenty words. The classification below is deliberately conservative, because the two
 * possible errors are not symmetric: over-classifying prose as code costs one unnecessary round, while under-classifying
 * code as prose would let a code change leave a code verdict standing.
 */
describe('code vs governance text', () => {




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
