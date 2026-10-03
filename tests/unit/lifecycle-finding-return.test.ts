import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileInitiative } from '../../src/workflow/lifecycle-reconciliation.js';
import type { InitiativeProjection } from '../../src/core/initiative-lifecycle.js';
import type { KataRelationsGraph } from '../../src/core/relations.js';
import { appendLifecycleEvent } from '../../src/core/initiative-lifecycle.js';
import { addLifecycleRelation } from '../../src/core/relations.js';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { writeDesignDeclarations } from '../../src/cli/lifecycle.js';
import { recordLifecycleTrigger } from '../../src/workflow/lifecycle-reconciliation.js';

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
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function tempRoot(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-finding-return-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'child', title: 'child', acceptance: [{ id: 'AC-1', statement: 'x' }] });
        return root;
    }

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
        });

        expect(result.unresolvedFindings).toEqual(['F-1']);
    });

    it('resolves once the successor revalidated on the current revision and the packet was consumed', () => {
        const result = reconcileInitiative({
            ...base,
            projection: projection({
                findings: { 'F-1': { status: 'revalidated' } },
                consumedPacketIds: ['edge-1:revision-a'],
            }),
        });

        expect(result.unresolvedFindings).toEqual([]);
    });

    it('does not accept an old revalidation and an unrelated consumed packet as the current return', () => {
        const result = reconcileInitiative({
            ...base,
            projection: projection({
                findings: { 'F-1': { status: 'transferred' } },
                consumedPacketIds: ['unrelated-packet'],
            }),
        });

        expect(result.unresolvedFindings).toEqual(['F-1']);
    });

    it('refuses a stored revalidation that is not bound to the latest consumed successor packet', async () => {
        const root = await tempRoot();
        const graph = await addLifecycleRelation({
            root,
            from: { type: 'change', id: 'records-initiative' },
            to: { type: 'task', id: 'child' },
            type: 'implements',
            lifecycle: {
                initiativeId: 'records-initiative',
                policy: 'implements_finding',
                requiredReturn: 'revalidation',
                sourceFindingIds: ['F-1'],
            },
        });
        const relationId = graph.relations[0]?.id as string;
        await appendLifecycleEvent(root, 'records-initiative', {
            type: 'impact_packet_recorded', relationId, packetId: `${relationId}:revision-current`,
        });
        await appendLifecycleEvent(root, 'records-initiative', {
            type: 'impact_packet_consumed', relationId, packetId: `${relationId}:revision-current`,
        });

        await expect(appendLifecycleEvent(root, 'records-initiative', {
            type: 'finding_revalidated',
            findingId: 'F-1',
            relationId,
            revisionId: 'revision-old',
            packetId: `${relationId}:revision-old`,
        })).rejects.toThrow(/current|packet|revision/i);

        await expect(appendLifecycleEvent(root, 'records-initiative', {
            type: 'finding_revalidated',
            findingId: 'F-1',
            relationId,
            revisionId: 'revision-current',
            packetId: `${relationId}:revision-current`,
        })).resolves.toMatchObject({ type: 'finding_revalidated' });
    });

});
