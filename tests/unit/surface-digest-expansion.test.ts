import { describe, expect, it } from 'vitest';
import { classifyDigestKeys, codeManifestHash, governanceManifestHash, instrumentManifestHash, surfaceDigests } from '../../src/quality/code-surface.js';

/**
 * The defect this file exists for, and why the obvious tests could not find it.
 *
 * A task's `ownedPaths` are frequently **directories** (`scripts`, `tests`, `packages/x/src/…`), while a revision's
 * `pathDigests` is keyed by **files** (699 of them on the measured task). Matching the two by string equality found
 * nothing for a directory-shaped owned path, so the surface digests were computed over the two documentation paths that
 * happened to be files — and looked perfectly healthy.
 *
 * The consequence is the failure mode §15 forbids, reached by a plausible implementation: **the code surface did not move
 * when code moved**, so a pass could be spared for a change it had never inspected. Every test here uses directory-shaped
 * owned paths, which is what the realistic fixture has and what the earlier ones did not.
 */
describe('surface digests expand directory-shaped owned paths to digest keys', () => {
    const task = { instruments: ['scripts/assert_acceptance_claims.py'] };
    const revision = {
        ownedPaths: ['scripts', 'tests', 'docs'],
        pathDigests: {
            'scripts/assert_acceptance_claims.py': 'checker-1',
            'scripts/other_tool.py': 'tool-1',
            'tests/test_x.py': 'test-1',
            'docs/spec.md': 'doc-1',
        },
    };

    it('classifies by digest key, not by owned path', () => {
        const split = classifyDigestKeys(revision, task);
        // The declaration names a *file* inside an owned *directory*; classifying the owned path would find no instrument.
        expect(split.instruments).toEqual(['scripts/assert_acceptance_claims.py']);
        expect(split.code).toEqual(['scripts/other_tool.py', 'tests/test_x.py']);
        expect(split.nonCode).toEqual(['docs/spec.md']);
    });

    it('moves the code surface when code moves', () => {
        const before = codeManifestHash(revision, task);
        const changed = { ...revision, pathDigests: { ...revision.pathDigests, 'tests/test_x.py': 'test-2' } };
        // The original defect: this was equal, and the surface looked healthy while nothing was being observed.
        expect(codeManifestHash(changed, task)).not.toBe(before);
    });

    it('keeps an instrument edit out of the code surface, and inside its own', () => {
        const before = surfaceDigests(revision, task);
        const changed = { ...revision, pathDigests: { ...revision.pathDigests, 'scripts/assert_acceptance_claims.py': 'checker-2' } };
        // §24.4's whole point, at the level where the digests actually live: editing the checker must not expire a pass
        // about the deliverable.
        expect(codeManifestHash(changed, task)).toBe(codeManifestHash(revision, task));
        expect(instrumentManifestHash(changed, task)).not.toBe(before.instrument);
        expect(governanceManifestHash(changed, task)).toBe(before.governance);
    });

    it('keeps a governance edit out of the code surface', () => {
        const changed = { ...revision, pathDigests: { ...revision.pathDigests, 'docs/spec.md': 'doc-2' } };
        expect(codeManifestHash(changed, task)).toBe(codeManifestHash(revision, task));
        expect(governanceManifestHash(changed, task)).not.toBe(governanceManifestHash(revision, task));
    });

    it('says "cannot be spoken for" rather than "unchanged" when a surface has no keys', () => {
        // No instruments declared: the instrument surface is null, and a caller must treat that as un-sparable.
        expect(instrumentManifestHash(revision, {})).toBeNull();
        expect(codeManifestHash(revision, {})).not.toBeNull();
        // No digest table at all (a legacy revision): every surface is null.
        expect(surfaceDigests({ ownedPaths: ['scripts'] }, task)).toEqual({ code: null, governance: null, instrument: null });
    });

    it('matches a file-shaped owned path to itself, and a trailing slash either way', () => {
        const fileOwned = { ownedPaths: ['scripts/assert_acceptance_claims.py'], pathDigests: { 'scripts/assert_acceptance_claims.py': 'x' } };
        expect(instrumentManifestHash(fileOwned, task)).not.toBeNull();
        const slashOwned = { ownedPaths: ['scripts/'], pathDigests: { 'scripts/other_tool.py': 'x' } };
        expect(codeManifestHash(slashOwned, task)).not.toBeNull();
    });
});
