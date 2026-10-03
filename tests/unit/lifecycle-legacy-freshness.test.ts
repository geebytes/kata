import { describe, expect, it } from 'vitest';
import { reconcileInitiative } from '../../src/workflow/lifecycle-reconciliation.js';
import type { InitiativeProjection } from '../../src/core/initiative-lifecycle.js';
import type { KataRelationsGraph } from '../../src/core/relations.js';

/**
 * **AC-8: a slice entering an Initiative is never silently treated as current, and an unrelated Initiative is not read.**
 *
 * Two halves of one property. The first is a design whose dependency surface was never declared — exactly the state a
 * slice is in the first time it joins an Initiative. Nothing can be compared, so the design is `needs_reassessment` and
 * the Initiative's overall answer is `undetermined`; both facts are reported because they answer different questions
 * ("must be looked at" versus "cannot be asserted as unaffected").
 *
 * The second half is boundedness: the walk starts at the Initiative's own endpoint, so an Initiative in another part of
 * the same graph is never visited even when its slice moved a path this Initiative depends on.
 *
 * This case owns its own file: sharing a selector with AC-2 made the seal deduplicate the check, leaving AC-8 with no
 * evidence.
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

describe('legacy admission and bounded traversal', () => {
    it('admits a legacy linked slice as needs_reassessment, never as silently fresh', () => {
        const result = reconcileInitiative({
            initiativeId: 'records-initiative',
            graph: graph({ initiativeId: 'records-initiative', policy: 'informs', requiredReturn: 'impact_packet' }),
            projection: projection(),
            // A design whose dependencies were never declared: it cannot be shown unaffected, so it is not reported so.
            designs: [{ designId: 'legacy-design', dependsOn: [] }],
            revisions: [{ taskId: 'child', revisionId: 'revision-a', changedPaths: ['src/core/layout.ts'] }],
        });

        expect(result.statusByDesign['legacy-design']).toBe('needs_reassessment');
        expect(result.overall).toBe('undetermined');
    });

    it('does not read or rebase an Initiative outside the changed relation component', () => {
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
            // Nothing this Initiative relates to moved; the other component did.
            revisions: [{ taskId: 'other-child', revisionId: 'revision-b', changedPaths: ['src/core/layout.ts'] }],
        });

        expect(result.impactPackets).toEqual([]);
        expect(result.visitedEndpoints).toEqual(['change:records-initiative', 'task:child']);
    });
});
