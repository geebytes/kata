import { describe, expect, it } from 'vitest';
import { freezeCandidate, planReCertification, targetedReviewPlan } from '../../src/quality/recertification.js';

/**
 * §7: independent certification belongs to a frozen change candidate. These tests ensure a new revision id alone
 * does not spend another cold pass, while an unprovable or semantic change still fails closed into a full review.
 */
describe('semantic re-certification planner', () => {
    const base = freezeCandidate({
        contentDigests: {
            'src/a.ts': 'a1',
            'src/b.ts': 'b1',
            'docs/guide.md': 'd1',
        },
        acceptanceHash: 'acceptance-v1',
        instrumentHash: 'instrument-v1',
        reviewPolicyHash: 'policy-v1',
        executorBoundaryHash: 'executor-v1',
        reviewIrHash: 'ir-v1',
        reviewedPaths: ['src/a.ts', 'src/b.ts', 'src/internal.ts'],
        criterionPaths: {
            'AC-1': ['src/a.ts'],
            'AC-2': ['src/b.ts'],
        },
        evidenceByCriterion: {
            'AC-1': 'evidence-a1',
            'AC-2': 'evidence-b1',
        },
    });

    it('content-addresses a freeze independent of map and path ordering', () => {
        const reordered = freezeCandidate({
            ...base,
            contentDigests: { 'docs/guide.md': 'd1', 'src/b.ts': 'b1', 'src/a.ts': 'a1' },
            reviewedPaths: ['src/internal.ts', 'src/b.ts', 'src/a.ts'],
            criterionPaths: { 'AC-2': ['src/b.ts'], 'AC-1': ['src/a.ts'] },
            evidenceByCriterion: { 'AC-2': 'evidence-b1', 'AC-1': 'evidence-a1' },
        });
        expect(reordered.hash).toBe(base.hash);
    });


    it('preserves certification when only a path outside every reviewed surface changes', () => {
        const current = freezeCandidate({ ...base, contentDigests: { ...base.contentDigests, 'docs/guide.md': 'd2' }, reviewIrHash: 'ir-v2' });

        expect(planReCertification(base, current, [])).toMatchObject({
            kind: 'no_review_needed',
            changedPaths: ['docs/guide.md'],
            reusedFreezeHash: base.hash,
        });
    });

    it('narrows to the affected criterion when a mapped reviewed path changes', () => {
        const current = freezeCandidate({ ...base, contentDigests: { ...base.contentDigests, 'src/a.ts': 'a2' }, reviewIrHash: 'ir-v2' });

        expect(planReCertification(base, current, [])).toMatchObject({
            kind: 'targeted_review',
            criterionIds: ['AC-1'],
            changedPaths: ['src/a.ts'],
        });
    });

    it('fails closed to a full review for an unmapped reviewed path', () => {
        const current = freezeCandidate({
            ...base,
            contentDigests: { ...base.contentDigests, 'src/internal.ts': 'new' },
            reviewIrHash: 'ir-v2',
        });

        expect(planReCertification(base, current, [])).toMatchObject({ kind: 'full_review', reason: 'unmapped_reviewed_path' });
    });

    it.each([
        ['acceptanceHash', 'acceptance-v2'],
        ['instrumentHash', 'instrument-v2'],
        ['reviewPolicyHash', 'policy-v2'],
        ['executorBoundaryHash', 'executor-v2'],
    ] as const)('requires a full review when the %s changes', (field, value) => {
        const current = freezeCandidate({ ...base, [field]: value });

        expect(planReCertification(base, current, [])).toMatchObject({ kind: 'full_review', reason: 'semantic_contract_changed' });
    });

    it('narrows an evidence-only change to its owning criterion', () => {
        const current = freezeCandidate({ ...base, evidenceByCriterion: { ...base.evidenceByCriterion, 'AC-2': 'evidence-b2' }, reviewIrHash: 'ir-v2' });

        expect(planReCertification(base, current, [])).toMatchObject({ kind: 'targeted_review', criterionIds: ['AC-2'], changedPaths: [] });
    });

    it('refuses to preserve a pass when an unresolved finding targets the reviewed surface', () => {
        const current = freezeCandidate({ ...base, contentDigests: { ...base.contentDigests, 'docs/guide.md': 'd2' }, reviewIrHash: 'ir-v2' });

        expect(planReCertification(base, current, [{ id: 'F-1', targetPaths: ['src/a.ts'] }])).toMatchObject({
            kind: 'full_review',
            reason: 'unresolved_finding_implicated',
        });
    });

    it('maps a targeted decision to the criteria a narrowed round must carry, keeping the rest as carried-over', () => {
        // §7.3: a `targeted_review` must actually narrow the round, or the decision is decorative — the reviewer would
        // still receive every criterion and re-derive the untouched ones, paying exactly the cost the decision exists to
        // avoid. Narrowing is not deletion: the criteria outside the impact set are stated as carried over from the
        // prior certification, so the round is smaller without becoming silently blind to what it is not re-checking.
        const current = freezeCandidate({ ...base, contentDigests: { ...base.contentDigests, 'src/a.ts': 'a2' }, reviewIrHash: 'ir-v2' });
        const decision = planReCertification(base, current, []);
        expect(decision.kind).toBe('targeted_review');

        const plan = targetedReviewPlan(decision, ['AC-1', 'AC-2', 'AC-3']);
        expect(plan.criterionIds).toEqual(['AC-1']);
        expect(plan.carriedOverCriterionIds).toEqual(['AC-2', 'AC-3']);
    });

    it('carries nothing over when the decision is a full review', () => {
        // A full round re-checks everything, so nothing is carried over and nothing is withheld.
        const plan = targetedReviewPlan({ kind: 'full_review', reason: 'semantic_contract_changed', changedPaths: [], previousFreezeHash: base.hash }, ['AC-1', 'AC-2']);
        expect(plan.criterionIds).toEqual(['AC-1', 'AC-2']);
        expect(plan.carriedOverCriterionIds).toEqual([]);
    });
});

/**
 * §7.4: the freeze must anchor on the reviewed content and the semantic contract — not on the platform's own check
 * configuration. Measured on a real task: sealing identical bytes under a different check set produced a new revision id
 * and a *different* freeze, because `reviewIrHash` was hashed whole and the IR carries `evidenceIds`. A completed
 * certification was therefore expired by an edit to how the platform checks things, which is exactly the cost the anchor
 * was supposed to remove.
 */
describe('the freeze anchors on what was reviewed', () => {
    it('does not move when only the check/evidence configuration moves', () => {
        const base = freezeCandidate({
            contentDigests: { 'src/a.ts': 'h1' },
            acceptanceHash: 'acc', instrumentHash: 'inst', reviewPolicyHash: 'pol', executorBoundaryHash: 'exe',
            reviewIrHash: 'ir-with-unit-check',
            reviewedPaths: ['src/a.ts'], criterionPaths: { 'AC-1': ['src/a.ts'] }, evidenceByCriterion: { 'AC-1': 'e1' },
        });
        // The same reviewed content, with one more check in the platform's configuration.
        const moreChecks = freezeCandidate({ ...base, reviewIrHash: 'ir-with-unit-and-lint' });

        expect(moreChecks.hash).toBe(base.hash);
    });
});
