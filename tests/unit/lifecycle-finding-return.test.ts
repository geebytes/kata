import { describe, expect, it } from 'vitest';
import { reconcileInitiative } from '../../src/workflow/lifecycle-reconciliation.js';
import type { InitiativeProjection } from '../../src/core/initiative-lifecycle.js';
import type { KataRelationsGraph } from '../../src/core/relations.js';

/**
 * **AC-4: handing a finding to a successor is not fixing it.**
 *
 * The parent's design stays unresolved until the successor's result was revalidated against the current revision **and**
 * the packet carrying that result was consumed. Both halves are required and neither is decoration: a revalidation whose
 * packet nobody read is a result that has not arrived, and a consumed packet with no revalidation is a receipt for a
 * check that was never re-run. Reading either alone as "done" is exactly how a transferred finding disappears without
 * being answered.
 *
 * This case owns its own file: it previously shared a selector with AC-2, and the seal deduplicated the check — leaving
 * AC-4 with no evidence at all, which verify reported as an insufficient evidence level.
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

function graph(): KataRelationsGraph {
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
                lifecycle: {
                    initiativeId: 'records-initiative',
                    policy: 'implements_finding',
                    requiredReturn: 'revalidation',
                    sourceFindingIds: ['F-1'],
                },
            },
        ],
    };
}

describe('a transferred finding stays unresolved until its return is complete', () => {
    const base = {
        initiativeId: 'records-initiative',
        graph: graph(),
        designs: [{ designId: 'parent-design', dependsOn: ['path:src/core/layout.ts'] }],
        revisions: [{ taskId: 'child', revisionId: 'revision-a', changedPaths: ['src/core/layout.ts'] }],
    };

    it('stays unresolved while nothing has come back', () => {
        const result = reconcileInitiative({
            ...base,
            projection: projection({ findings: { 'F-1': { status: 'transferred' } } }),
        });

        expect(result.unresolvedFindings).toEqual(['F-1']);
    });

    it('stays unresolved when the revalidation arrived but its packet was never consumed', () => {
        const result = reconcileInitiative({
            ...base,
            projection: projection({
                findings: { 'F-1': { status: 'transferred' } },
                openPacketIds: ['packet-1'],
            }),
            revalidations: [{ findingId: 'F-1', revisionId: 'revision-a' }],
        });

        expect(result.unresolvedFindings).toEqual(['F-1']);
    });

    it('resolves once the successor revalidated on the current revision and the packet was consumed', () => {
        const result = reconcileInitiative({
            ...base,
            projection: projection({
                findings: { 'F-1': { status: 'transferred' } },
                consumedPacketIds: ['packet-1'],
            }),
            revalidations: [{ findingId: 'F-1', revisionId: 'revision-a' }],
        });

        expect(result.unresolvedFindings).toEqual([]);
    });
});
