import { describe, expect, it } from 'vitest';
import { reconcileInitiative } from '../../src/workflow/lifecycle-reconciliation.js';
import type { InitiativeProjection } from '../../src/core/initiative-lifecycle.js';
import type { KataRelationsGraph } from '../../src/core/relations.js';

/**
 * **AC-2 / AC-3: impact is evaluated over the changed relation component, and `undetermined` is not `fresh`.**
 *
 * A related child's seal must not make every Initiative re-read the repository: the evaluation walks the changed edge's
 * connected component and intersects manifests. And an input nobody could read — a relation with no lifecycle metadata, a
 * revision nobody supplied — is a case where the answer is not known, so it is reported as `undetermined` rather than as
 * "unaffected". That distinction is the shape of every stale-audit failure this change exists to remove.
 *
 * AC-4 and AC-8 own their own files (`lifecycle-finding-return`, `lifecycle-legacy-freshness`) because a check that two
 * criteria share is a check the seal deduplicates, leaving one of them with no evidence at all — measured, and the reason
 * this file no longer carries their cases.
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
        expect(result.impactPackets).toEqual([]);
    });

    it('visits only the changed relation component, and reports what it visited', () => {
        const base = graph({ initiativeId: 'records-initiative', policy: 'informs', requiredReturn: 'impact_packet' });
        const withOther: KataRelationsGraph = {
            ...base,
            relations: [
                ...base.relations,
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
        };

        const result = reconcileInitiative({
            initiativeId: 'records-initiative',
            graph: withOther,
            projection: projection(),
            designs: [{ designId: 'parent-design', dependsOn: ['path:src/core/layout.ts'] }],
            revisions: [{ taskId: 'other-child', revisionId: 'revision-b', changedPaths: ['src/core/layout.ts'] }],
        });

        // The other Initiative's slice moved a path this design depends on, and it is still not this Initiative's problem.
        expect(result.impactPackets).toEqual([]);
        expect(result.visitedEndpoints).toEqual(['change:records-initiative', 'task:child']);
    });
    it('returns undetermined when a related lifecycle child has no revision manifest', () => {
        const result = reconcileInitiative({
            initiativeId: 'records-initiative',
            graph: graph({ initiativeId: 'records-initiative', policy: 'informs', requiredReturn: 'impact_packet' }),
            projection: projection(),
            designs: [{ designId: 'parent-design', dependsOn: ['path:src/core/layout.ts'] }],
            revisions: [],
        });

        expect(result.overall).toBe('undetermined');
        expect(result.statusByDesign['parent-design']).toBe('undetermined');
    });

});
