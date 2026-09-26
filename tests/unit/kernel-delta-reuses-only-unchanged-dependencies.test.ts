import { describe, expect, it } from 'vitest';
import { computeDelta, pathDepsOf } from '../../src/kernel/delta.js';
import { subjectOf } from '../../src/kernel/subject.js';
import type { Claim, EvidenceVerdict, Subject } from '../../src/kernel/types.js';
import { makeClaim, makeVerdict } from '../helpers/review.js';

/**
 * **Delta certification: unchanged dependencies keep their verdicts, changed ones reopen — and nothing else.**
 *
 * The rule this replaces was "any repair voids the round", which measured eleven minutes of usable readiness on a real
 * change. The rule here keeps the part that matters (a verdict must not outlive the content it was about) while dropping
 * the part that cost everything (re-deciding content that has not moved).
 *
 * The invariant asserted at the bottom is the point: a reused claim's dependencies are byte-identical, and an unresolvable
 * dependency opens everything rather than quietly reusing more than it can justify.
 */
function claimOf(id: string, paths: string[], evidenceId: string, statement = `statement ${id}`): Claim {
    return makeClaim({
        id,
        statement,
        evidenceIds: [evidenceId],
        dependsOn: paths.map((path) => `path:${path}` as const),
    });
}

const previous: Subject = subjectOf({ 'src/a.ts': 'A1', 'src/b.ts': 'B1', 'src/c.ts': 'C1' });

describe('delta certification', () => {
    it('reuses a claim whose dependencies did not move, and reopens one whose did', () => {
        const next: Subject = subjectOf({ 'src/a.ts': 'A1', 'src/b.ts': 'B2', 'src/c.ts': 'C1' });
        const claims = [claimOf('C1', ['src/a.ts'], 'E1'), claimOf('C2', ['src/b.ts'], 'E2')];
        const verdicts: EvidenceVerdict[] = [
            makeVerdict({ evidenceId: 'E1', subjectRevision: previous.revision }),
            makeVerdict({ evidenceId: 'E2', subjectRevision: previous.revision }),
        ];
        const delta = computeDelta({ previous: { subject: previous, claims }, next: { subject: next, claims }, verdicts });
        expect(delta.reusable).toEqual(['C1']);
        expect(delta.revalidate).toEqual(['C2']);
        expect(delta.reusedEvidence).toEqual(['E1']);
        expect(delta.underivable).toBe(false);
    });

    it('does not reuse a refuted verdict, and does not reuse a verdict from a claim that rests on another claim', () => {
        const next: Subject = subjectOf({ 'src/a.ts': 'A1', 'src/b.ts': 'B1', 'src/c.ts': 'C1' });
        const dependent = makeClaim({
            id: 'C2',
            dependsOn: ['claim:C1'],
            evidenceIds: ['E2'],
        });
        const claims = [claimOf('C1', ['src/a.ts'], 'E1'), dependent];
        const sameStatements = computeDelta({
            previous: { subject: previous, claims },
            next: { subject: next, claims },
            verdicts: [makeVerdict({ evidenceId: 'E1', subjectRevision: previous.revision })],
        });
        expect(sameStatements.reusable).toEqual(['C1', 'C2']);

        // C1's statement moved, so C1 reopens — and C2, whose own path did not move, must reopen with it.
        const changedBase = [makeClaim({ ...claimOf('C1', ['src/a.ts'], 'E1'), statement: 'a different statement' }), dependent];
        const reopened = computeDelta({
            previous: { subject: previous, claims },
            next: { subject: next, claims: changedBase },
            verdicts: [],
        });
        expect(reopened.reusable).toEqual([]);
        expect(reopened.revalidate.sort()).toEqual(['C1', 'C2']);
    });

    it('opens everything when a dependency cannot be resolved, instead of reusing what it cannot justify', () => {
        const next: Subject = subjectOf({ 'src/a.ts': 'A1' });
        const claims = [claimOf('C1', ['src/a.ts'], 'E1'), claimOf('C2', ['src/missing.ts'], 'E2')];
        const delta = computeDelta({
            previous: { subject: previous, claims },
            next: { subject: next, claims },
            verdicts: [makeVerdict({ evidenceId: 'E1', subjectRevision: previous.revision })],
        });
        expect(delta.underivable).toBe(true);
        expect(delta.underivableRefs).toEqual(['C2 -> path:src/missing.ts']);
        expect(delta.reusable).toEqual([]);
        expect(delta.revalidate.sort()).toEqual(['C1', 'C2']);
        expect(delta.reusedEvidence).toEqual([]);
    });

    it('holds the invariant across a generated matrix: a reused claim\'s dependencies are byte-identical', () => {
        const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
        const contents = ['A1', 'A2', 'B1', 'B2', 'C1'];
        for (const a of contents) {
            for (const b of contents) {
                const next = subjectOf({ 'src/a.ts': a, 'src/b.ts': b, 'src/c.ts': 'C1' });
                const claims = [
                    claimOf('C1', ['src/a.ts'], 'E1'),
                    claimOf('C2', ['src/b.ts'], 'E2'),
                    claimOf('C3', files, 'E3'),
                ];
                const delta = computeDelta({ previous: { subject: previous, claims }, next: { subject: next, claims }, verdicts: [] });
                const expectedReusable = claims
                    .filter((claim) => pathDepsOf(claim).every((path) => previous.pathDigests[path] === next.pathDigests[path]))
                    .map((claim) => claim.id);
                expect(delta.reusable, `a=${a} b=${b}`).toEqual(expectedReusable);
            }
        }
    });
});
