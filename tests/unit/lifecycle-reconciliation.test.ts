import { describe, expect, it } from 'vitest';
import { reconcileInitiative } from '../../src/workflow/lifecycle-reconciliation.js';
import type { InitiativeProjection } from '../../src/core/initiative-lifecycle.js';
import type { KataRelationsGraph } from '../../src/core/relations.js';

/**
 * **Reconciliation is a pure evaluation over the relation graph, the projection and the manifests.**
 *
 * Three properties are pinned, and each one is a defect this repository has already paid for at another layer.
 *
 * *Bounded work.* A related child's seal must not make every Initiative re-read the repository. The evaluation walks the
 * changed edge's connected component and intersects manifests, so an unrelated Initiative is not visited at all — and the
 * visited endpoints are returned so that claim is observable rather than asserted.
 *
 * *`undetermined` is not `fresh`.* An unreadable relation, a missing manifest or a missing lifecycle metadata is a case
 * where nobody knows yet. Reporting it as "unaffected" is the shape of every stale-audit failure: the answer looks like a
 * pass and nothing tells the operator that nothing was read.
 *
 * *A transferred finding stays unresolved.* Handing a finding to a successor is not fixing it, and the parent's design is
 * not clean until the successor's result is revalidated against the current revision and its packet is consumed.
 */

function projection(overrides: Partial<InitiativeProjection> = {}): InitiativeProjection {
    return {
        initiativeId: 'records-initiative',
        status: 'active',
        designs: { 'parent-design': { status: 'active' } },
        findings: {},
        openPacketIds: [],
        consumedPacketIds: [],
        retired: [],
        candidates: [],
        ...overrides,
    };
}

function graph(lifecycle: KataRelationsGraph['relations'][number]['lifecycle']): KataRelationsGraph {
    return {
        version: 2,
        updatedAt: '2026-10-03T00:00:00.000Z',
        relations: [
            {
                id: 'edge-1',
                kind: 'context',
                type: 'related_to',
                from: { type: 'change', id: 'records-initiative' },
                to: { type: 'task', id: 'child' },
                createdAt: '2026-10-03T00:00:00.000Z',
                ...(lifecycle ? { lifecycle } : {}),
            },
        ],
    };
}

describe('lifecycle reconciliation', () => {
    it('marks only the related design needs_reassessment when a child manifest intersects its dependency manifest', () => {
        const result = reconcileInitiative({
            initiativeId: 'records-initiative',
            graph: graph({ initiativeId: 'records-initiative', policy: 'informs', requiredReturn: 'impact_packet' }),
            projection: projection(),
            designs: [
                { designId: 'parent-design', dependsOn: ['path:src/core/layout.ts'] },
                { designId: 'unrelated-design', dependsOn: ['path:src/wiki/lifecycle.ts'] },
            ],
            revisions: [{ taskId: 'child', revisionId: 'revision-a', changedPaths: ['src/core/layout.ts'] }],
        });

        expect(result.statusByDesign['parent-design']).toBe('needs_reassessment');
        expect(result.statusByDesign['unrelated-design']).toBe('fresh');
        expect(result.impactPackets).toContainEqual(
            expect.objectContaining({ relationId: 'edge-1', result: 'needs_reassessment' })
        );
    });

    it('returns undetermined when an incoming relation carries no lifecycle metadata', () => {
        const result = reconcileInitiative({
            initiativeId: 'records-initiative',
            graph: graph(undefined),
            projection: projection(),
            designs: [{ designId: 'parent-design', dependsOn: ['path:src/core/layout.ts'] }],
            revisions: [{ taskId: 'child', revisionId: 'revision-a', changedPaths: ['src/core/layout.ts'] }],
        });

        expect(result.overall).toBe('undetermined');
        expect(result.statusByDesign['parent-design']).toBe('undetermined');
    });

    it('keeps a transferred finding unresolved until current-revision revalidation and packet consumption both exist', () => {
        const transferred = projection({ findings: { 'F-1': { status: 'transferred' } } });

        const withoutReturn = reconcileInitiative({
            initiativeId: 'records-initiative',
            graph: graph({ initiativeId: 'records-initiative', policy: 'implements_finding', requiredReturn: 'revalidation', sourceFindingIds: ['F-1'] }),
            projection: transferred,
            designs: [{ designId: 'parent-design', dependsOn: ['path:src/core/layout.ts'] }],
            revisions: [{ taskId: 'child', revisionId: 'revision-a', changedPaths: ['src/core/layout.ts'] }],
        });

        expect(withoutReturn.unresolvedFindings).toEqual(['F-1']);

        const revalidatedOnly = reconcileInitiative({
            initiativeId: 'records-initiative',
            graph: graph({ initiativeId: 'records-initiative', policy: 'implements_finding', requiredReturn: 'revalidation', sourceFindingIds: ['F-1'] }),
            projection: projection({
                findings: { 'F-1': { status: 'transferred' } },
                openPacketIds: ['packet-1'],
            }),
            designs: [{ designId: 'parent-design', dependsOn: ['path:src/core/layout.ts'] }],
            revisions: [{ taskId: 'child', revisionId: 'revision-a', changedPaths: ['src/core/layout.ts'] }],
            revalidations: [{ findingId: 'F-1', revisionId: 'revision-a' }],
        });

        // The successor re-ran the check, but its packet has not been consumed, so the parent is not yet relieved of it.
        expect(revalidatedOnly.unresolvedFindings).toEqual(['F-1']);
    });

    it('does not read or rebase an Initiative outside the changed relation component', () => {
        const result = reconcileInitiative({
            initiativeId: 'records-initiative',
            graph: {
                version: 2,
                updatedAt: '2026-10-03T00:00:00.000Z',
                relations: [
                    {
                        id: 'edge-1',
                        kind: 'context',
                        type: 'related_to',
                        from: { type: 'change', id: 'records-initiative' },
                        to: { type: 'task', id: 'child' },
                        createdAt: '2026-10-03T00:00:00.000Z',
                        lifecycle: { initiativeId: 'records-initiative', policy: 'informs', requiredReturn: 'impact_packet' },
                    },
                    {
                        id: 'edge-2',
                        kind: 'context',
                        type: 'related_to',
                        from: { type: 'change', id: 'other-initiative' },
                        to: { type: 'task', id: 'other-child' },
                        createdAt: '2026-10-03T00:00:00.000Z',
                        lifecycle: { initiativeId: 'other-initiative', policy: 'informs', requiredReturn: 'impact_packet' },
                    },
                ],
            },
            projection: projection(),
            designs: [{ designId: 'parent-design', dependsOn: ['path:src/core/layout.ts'] }],
            // Nothing this Initiative relates to moved.
            revisions: [{ taskId: 'other-child', revisionId: 'revision-b', changedPaths: ['src/core/layout.ts'] }],
        });

        expect(result.impactPackets).toEqual([]);
        expect(result.visitedEndpoints).toEqual(['change:records-initiative', 'task:child']);
    });
});
