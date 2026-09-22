import { describe, expect, it } from 'vitest';
import { evaluateAdversarialGate, type AdversarialRecord } from '../../src/quality/adversarial.js';

/**
 * C2, and the precondition that makes it safe.
 *
 * The measurement: **three of six cycles in one day were pure governance-text edits** — one acceptance statement, three
 * rewrites — each costing about an hour of re-verification for roughly twenty words.
 *
 * §16 is explicit about why this may only be wired *after* C3: "6 is only safe once 3 exists — otherwise a text edit could
 * leave a stale truth claim satisfied". A governance-text edit changes the *sentences*, and the sentences are what the
 * claims check. So a pass is spared only when something cheap has re-read them; the last test below is that precondition
 * failing, which must look exactly like the strict behaviour it replaces.
 */
describe('a revision that differs only in governance text', () => {
    const record: AdversarialRecord = {
        node: 'verify',
        status: 'recorded',
        revisionId: 'revision-code',
        manifestHash: 'manifest-full-1',
        codeManifestHash: 'code-1',
        createdAt: '2026-09-19T00:00:00.000Z',
        executedInFreshContext: true,
        briefSha256: 'brief-1',
        attempts: [{ hypothesis: 'h', method: 'm', outcome: 'refuted' }],
        findings: [],
        scope: { kind: 'full' },
    };

    const gate = (overrides: Record<string, unknown> = {}): ReturnType<typeof evaluateAdversarialGate> =>
        evaluateAdversarialGate(record, {
            node: 'verify',
            revisionId: 'revision-text',
            manifestHash: 'manifest-full-2',
            codeManifestHash: 'code-1',
            issuedBriefSha256s: ['brief-1'],
            claimsVerified: true,
            ...overrides,
        });

    it('spares a pass that verified the code, when the claims were re-read', () => {
        // A docs-only edit: new revision id, new full manifest, **identical code surface** — and the claims re-verified.
        expect(gate()).toMatchObject({ satisfied: true });
    });

    it('does not spare it when the claims have not been re-read on this revision', () => {
        // The stale-truth-claim hazard §16 names: the sentence changed and nothing checked the new one.
        expect(gate({ claimsVerified: false })).toMatchObject({ satisfied: false, reason: 'stale_revision' });
        // …and the default is the strict answer, so a caller that has not thought about it gets the old behaviour.
        expect(gate({ claimsVerified: undefined })).toMatchObject({ satisfied: false, reason: 'stale_revision' });
    });

    it('does not spare it when code changed', () => {
        expect(gate({ codeManifestHash: 'code-2' })).toMatchObject({ satisfied: false, reason: 'stale_revision' });
    });

    it('expires the pass when the CandidateFreeze moved even though the owned manifest did not (§7.4)', () => {
        // `manifestHash` covers only the *declared* owned paths. A change committed outside the declaration leaves it
        // byte-identical while the reviewed content has moved — measured on this project as a commit touching .gitignore,
        // docs/guide.md and src/a.ts that the record still read as `changedPaths ['src/a.ts']`. When both sides can name
        // a freeze, the freeze is the binding, so that shape is refused instead of silently certifying stale content.
        const frozen: AdversarialRecord = { ...record, candidateFreezeSha256: 'a'.repeat(64) };

        expect(
            evaluateAdversarialGate(frozen, {
                node: 'verify',
                revisionId: 'revision-text',
                manifestHash: 'manifest-full-2',
                codeManifestHash: 'code-1',
                issuedBriefSha256s: ['brief-1'],
                claimsVerified: true,
                // Same owned manifest, different freeze: the content the pass answered is not the content in hand.
                candidateFreezeSha256: 'b'.repeat(64),
            }),
        ).toMatchObject({ satisfied: false, reason: 'stale_revision' });
    });

    it('still spares the pass when the freeze agrees, and does not fail a record that predates the contract', () => {
        const frozen: AdversarialRecord = { ...record, candidateFreezeSha256: 'a'.repeat(64) };
        expect(
            evaluateAdversarialGate(frozen, {
                node: 'verify',
                revisionId: 'revision-text',
                manifestHash: 'manifest-full-2',
                codeManifestHash: 'code-1',
                issuedBriefSha256s: ['brief-1'],
                claimsVerified: true,
                candidateFreezeSha256: 'a'.repeat(64),
            }),
        ).toMatchObject({ satisfied: true });

        // A legacy record carries no freeze; the older binding must keep working rather than failing on a missing field.
        expect(gate({ candidateFreezeSha256: 'a'.repeat(64) })).toMatchObject({ satisfied: true });
    });

    it('does not spare it when either side cannot name the code surface', () => {
        // A legacy record, or a revision sealed before per-path digests: the split cannot be made, so no sparing.
        expect(gate({ codeManifestHash: null })).toMatchObject({ satisfied: false, reason: 'stale_revision' });
        const legacy: AdversarialRecord = { ...record };
        delete legacy.codeManifestHash;
        expect(
            evaluateAdversarialGate(legacy, {
                node: 'verify',
                revisionId: 'revision-text',
                manifestHash: 'manifest-full-2',
                codeManifestHash: 'code-1',
                issuedBriefSha256s: ['brief-1'],
                claimsVerified: true,
            }),
        ).toMatchObject({ satisfied: false, reason: 'stale_revision' });
    });

    it('still requires the brief binding, the fresh context and an attempt', () => {
        // Sparing the pass is not a way around any other part of the gate.
        expect(gate({ issuedBriefSha256s: ['brief-other'] })).toMatchObject({ satisfied: false, reason: 'brief_not_issued' });
        expect(
            evaluateAdversarialGate({ ...record, executedInFreshContext: false }, {
                node: 'verify',
                revisionId: 'revision-text',
                manifestHash: 'manifest-full-2',
                codeManifestHash: 'code-1',
                issuedBriefSha256s: ['brief-1'],
                claimsVerified: true,
            }),
        ).toMatchObject({ satisfied: false, reason: 'not_fresh_context' });
    });
});
