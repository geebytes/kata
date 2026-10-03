import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendLifecycleEvent, readInitiativeLifecycle } from '../../src/core/initiative-lifecycle.js';
import { addLifecycleRelation } from '../../src/core/relations.js';
import { createTask } from '../../src/core/task.js';
import { initLayout } from '../../src/core/layout.js';
import { recordLifecycleTrigger } from '../../src/workflow/lifecycle-reconciliation.js';
import { designsPath } from '../../src/cli/lifecycle.js';

/**
 * **AC-7: a later related change moves the projection, not the record.**
 *
 * The historical `initiative_closed` event is a record of something that did happen, so a revision landing afterwards
 * cannot rewrite it; what changes is the current projection (`needs_reconciliation`) plus the reconciliation-slice
 * candidate that says so.
 *
 * This criterion owns its own file because sharing a selector with AC-6 made the seal deduplicate the check and leave
 * AC-7 with no evidence at all — the third instance of that class on this change, and the reason every criterion here now
 * names a file only it uses.
 */
describe('initiative post-closure impact', () => {
    const roots: string[] = [];

    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function tempRoot(prefix: string, taskIds: string[]): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), prefix));
        roots.push(root);
        await initLayout(root);
        for (const taskId of taskIds) {
            await createTask({ root, id: taskId, title: taskId, acceptance: [{ id: 'AC-1', statement: 'x' }] });
        }
        return root;
    }

    it('does not rewrite historical closure after a later related revision', async () => {
        const root = await tempRoot('kata-lifecycle-post-closure-', ['child']);
        const graph = await addLifecycleRelation({
            root,
            from: { type: 'change', id: 'records-initiative' },
            to: { type: 'task', id: 'child' },
            type: 'related_to',
            lifecycle: { initiativeId: 'records-initiative', policy: 'informs', requiredReturn: 'impact_packet' },
        });
        await appendLifecycleEvent(root, 'records-initiative', { type: 'initiative_created', initiativeId: 'records-initiative' });
        await appendLifecycleEvent(root, 'records-initiative', { type: 'initiative_closed', reason: 'all slices accounted for' });
        await writeFile(designsPath(root, 'records-initiative'), `${JSON.stringify({
            designs: [{ designId: 'parent-design', dependsOn: ['path:src/core/layout.ts'] }],
        })}\n`, 'utf8');

        // A later related child revision lands after the closure.
        await recordLifecycleTrigger(root, { taskId: 'child', revisionId: 'revision-late', changedPaths: ['src/core/layout.ts'] });

        const state = await readInitiativeLifecycle(root, 'records-initiative');
        // The closure event is still there, in its original position in the history.
        expect(state.history).toContainEqual(expect.objectContaining({ type: 'initiative_closed' }));
        // And the projection is what moved.
        expect(state.current.status).toBe('needs_reconciliation');
        expect(state.current.candidates).toContainEqual(expect.objectContaining({ kind: 'reconciliation_slice' }));
        // The graph is unchanged by a projection move: nothing was re-pointed to make this work.
        expect(graph.relations).toHaveLength(1);
    });
});
