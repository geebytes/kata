import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTask } from '../../src/core/task.js';
import { addLifecycleRelation } from '../../src/core/relations.js';

/**
 * **AC-3: a lifecycle edge may not close a cycle, and `independent` is a claim about surfaces that is checked.**
 *
 * Both rules are about the graph rather than about the edge, so both are written here with a selector of their own: a
 * check two criteria share is a check the seal deduplicates, and the criterion left without evidence then fails verify —
 * measured on this change before the files were split.
 *
 * The cycle rule walks the graph's own edges, because a second structure holding "which nodes reach which" would be one
 * more thing that can disagree with the one topology. The `independent` rule refuses an overlapping declared surface
 * because "these two do not affect each other" is exactly the claim that must not be taken on trust.
 */
describe('lifecycle relation safety', () => {
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

    it('refuses a lifecycle edge that would close a cycle', async () => {
        const root = await tempRoot('kata-lifecycle-cycle-', ['initiative-child']);

        await addLifecycleRelation({
            root,
            from: { type: 'change', id: 'initiative' },
            to: { type: 'task', id: 'initiative-child' },
            type: 'contains',
            lifecycle: { initiativeId: 'initiative', policy: 'informs', requiredReturn: 'impact_packet' },
        });

        // The child claiming to contain the Initiative that contains it.
        await expect(addLifecycleRelation({
            root,
            from: { type: 'task', id: 'initiative-child' },
            to: { type: 'change', id: 'initiative' },
            type: 'contains',
            lifecycle: { initiativeId: 'initiative', policy: 'informs', requiredReturn: 'none' },
        })).rejects.toThrow(/cycle/);
    });

    it('refuses an independent lifecycle edge whose declared surfaces overlap', async () => {
        const root = await tempRoot('kata-lifecycle-independent-', ['other-child']);

        await expect(addLifecycleRelation({
            root,
            from: { type: 'change', id: 'initiative' },
            to: { type: 'task', id: 'other-child' },
            type: 'related_to',
            lifecycle: {
                initiativeId: 'initiative',
                policy: 'independent',
                requiredReturn: 'none',
                declaredSurfaces: { from: ['src/core/layout.ts'], to: ['src/core/layout.ts'] },
            },
        })).rejects.toThrow(/independent .*overlap/);
    });

    it('accepts an independent lifecycle edge whose declared surfaces do not overlap', async () => {
        const root = await tempRoot('kata-lifecycle-independent-ok-', ['other-child']);

        const graph = await addLifecycleRelation({
            root,
            from: { type: 'change', id: 'initiative' },
            to: { type: 'task', id: 'other-child' },
            type: 'related_to',
            lifecycle: {
                initiativeId: 'initiative',
                policy: 'independent',
                requiredReturn: 'none',
                declaredSurfaces: { from: ['src/core/layout.ts'], to: ['src/wiki/lifecycle.ts'] },
            },
        });

        expect(graph.relations).toHaveLength(1);
        expect(graph.relations[0]?.lifecycle?.policy).toBe('independent');
    });
});
