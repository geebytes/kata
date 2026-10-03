import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    appendLifecycleEvent,
    impactPacketsPath,
    initiativeDir,
    readInitiativeLifecycle,
} from '../../src/core/initiative-lifecycle.js';
import { addLifecycleRelation } from '../../src/core/relations.js';
import { createTask } from '../../src/core/task.js';

/**
 * **Lifecycle history is append-only, and its projection is derived.**
 *
 * The projection answers "what is the current state of this Initiative's designs and slices", and it has to survive being
 * re-derived after every event — so the events are the record and the projection is a view of them. Two properties are
 * pinned here because both are silent when wrong: a malformed line must read as `unreadable` rather than as "no history"
 * (an unreadable audit trail reported as an empty one is the failure this repository keeps re-finding), and an event that
 * names a relation which does not exist in the graph must fail closed, because a lifecycle record pointing at nothing is
 * exactly the stale binding the stable relation id was introduced to prevent.
 */
describe('initiative lifecycle store', () => {
    const roots: string[] = [];

    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function tempRoot(prefix: string, taskIds: string[]): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), prefix));
        roots.push(root);
        for (const taskId of taskIds) {
            await createTask({ root, id: taskId, title: taskId, acceptance: [{ id: 'AC-1', statement: 'x' }] });
        }
        return root;
    }

    it('projects append-only events while retaining every historical packet', async () => {
        const root = await tempRoot('kata-lifecycle-store-', ['child']);
        const graph = await addLifecycleRelation({
            root,
            from: { type: 'change', id: 'records-initiative' },
            to: { type: 'task', id: 'child' },
            type: 'contains',
            lifecycle: { initiativeId: 'records-initiative', policy: 'informs', requiredReturn: 'impact_packet' },
        });
        const relationId = graph.relations[0]?.id as string;

        await appendLifecycleEvent(root, 'records-initiative', {
            type: 'design_needs_reassessment',
            relationId,
            designId: 'design-1',
            reason: 'the child declared a surface the design depends on',
        });
        await appendLifecycleEvent(root, 'records-initiative', {
            type: 'impact_packet_consumed',
            relationId,
            packetId: 'packet-1',
        });

        const state = await readInitiativeLifecycle(root, 'records-initiative');

        expect(state.readState).toBe('usable');
        expect(state.history).toHaveLength(2);
        expect(state.current.consumedPacketIds).toEqual(['packet-1']);

        // The escalation survives its consumption: the packet is what answered it, not something that erased it.
        expect(state.history[0]?.type).toBe('design_needs_reassessment');
        expect(state.current.designs['design-1']?.status).toBe('needs_reassessment');
    });

    it('reports a malformed lifecycle line as unreadable instead of an empty history', async () => {
        const root = await tempRoot('kata-lifecycle-malformed-', ['child']);
        await appendLifecycleEvent(root, 'records-initiative', {
            type: 'initiative_created',
            initiativeId: 'records-initiative',
        });
        await writeFile(impactPacketsPath(root, 'records-initiative'), '{broken}\n', 'utf8');

        const state = await readInitiativeLifecycle(root, 'records-initiative');

        expect(state.readState).toBe('unreadable');
    });

    it('refuses an event that names a relation the graph does not contain', async () => {
        const root = await tempRoot('kata-lifecycle-binding-', ['child']);

        await expect(appendLifecycleEvent(root, 'records-initiative', {
            type: 'design_needs_reassessment',
            relationId: 'edge-does-not-exist',
            designId: 'design-1',
            reason: 'bound to nothing',
        })).rejects.toThrow(/edge-does-not-exist/);

        // Nothing was written: a refused event leaves no half-record behind.
        await expect(readFile(join(initiativeDir(root, 'records-initiative'), 'events.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('reads an Initiative that was never created as absent, not as an empty one', async () => {
        const root = await tempRoot('kata-lifecycle-absent-', ['child']);

        const state = await readInitiativeLifecycle(root, 'never-created');

        expect(state.readState).toBe('absent');
        expect(state.history).toEqual([]);
    });
});
