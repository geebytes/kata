import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTask } from '../../src/core/task.js';
import { addKataRelation, addLifecycleRelation, readKataRelations } from '../../src/core/relations.js';
import { relationsPath } from '../../src/core/layout.js';

/**
 * **Lifecycle relations live in the one authoritative graph.**
 *
 * `.kata/relations.json` is already the sole topology (`src/core/relations.ts`), so an Initiative must be an endpoint in
 * it rather than a second graph beside it. What the graph could not express is the lifecycle dimension: `KataRelation`
 * has no stable `id`, and `addKataRelation` replaces by `(from, to, type)` — so a lifecycle record that wanted to point
 * at "one particular relation" could not name it, and would have to fingerprint the endpoints. A fingerprint binding
 * breaks the moment the relation is rewritten, which is exactly the second-derivation defect this change exists to
 * remove. These cases pin the stable id, the lifecycle metadata, and the migration that keeps a v1 graph readable.
 */
describe('lifecycle relations', () => {
    const roots: string[] = [];

    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    /** Real task records through the production constructor, so the fixture cannot invent a shape no reader accepts. */
    async function tempRoot(prefix: string, taskIds: string[]): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), prefix));
        roots.push(root);
        for (const taskId of taskIds) {
            await createTask({ root, id: taskId, title: taskId, acceptance: [{ id: 'AC-1', statement: 'x' }] });
        }
        return root;
    }

    async function graphVersion(root: string): Promise<number> {
        const raw = JSON.parse(await readFile(relationsPath(root), 'utf8')) as { version: number };
        return raw.version;
    }

    it('allocates a stable lifecycle edge id once and keeps lifecycle metadata only in the graph', async () => {
        const root = await tempRoot('kata-lifecycle-relations-', ['records-initiative', 'repair-owner']);

        const graph = await addLifecycleRelation({
            root,
            from: { type: 'change', id: 'records-initiative' },
            to: { type: 'task', id: 'repair-owner' },
            type: 'contains',
            lifecycle: { initiativeId: 'records-initiative', policy: 'informs', requiredReturn: 'impact_packet' },
        });

        expect(graph.relations).toHaveLength(1);
        expect(graph.relations[0]?.id).toEqual(expect.any(String));
        expect(graph.relations[0]?.lifecycle).toEqual({
            initiativeId: 'records-initiative',
            policy: 'informs',
            requiredReturn: 'impact_packet',
        });

        // The id is durable and unchanged by a re-read: a lifecycle record must be able to name this edge later.
        const reread = await readKataRelations(root);
        expect(reread.relations[0]?.id).toBe(graph.relations[0]?.id);

        // No second relation store anywhere under the initiative's own directory.
        await expect(readFile(join(root, '.kata/initiatives/records-initiative/relations.jsonl'), 'utf8')).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    it('keeps a legacy v1 graph readable and upgrades every edge once, during the first locked write', async () => {
        const root = await tempRoot('kata-lifecycle-migration-', ['a', 'b']);
        const legacy = {
            version: 1,
            relations: [
                { kind: 'context', type: 'related_to', from: { type: 'task', id: 'a' }, to: { type: 'task', id: 'b' }, createdAt: '2026-09-17T00:00:00.000Z' },
            ],
            updatedAt: '2026-09-17T00:00:00.000Z',
        };
        await writeFile(relationsPath(root), `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');

        // A read of a v1 graph is a read: the historical record stays byte-identical because the reader mints nothing.
        const before = await readFile(relationsPath(root), 'utf8');
        const read = await readKataRelations(root);
        expect(read.relations).toHaveLength(1);
        expect(await readFile(relationsPath(root), 'utf8')).toBe(before);

        // The first locked write upgrades the whole graph, so no edge is left without an identity.
        await addKataRelation({
            root,
            from: { type: 'task', id: 'a' },
            to: { type: 'task', id: 'b' },
            type: 'depends_on',
            createdBy: 'test',
        });

        const upgraded = JSON.parse(await readFile(relationsPath(root), 'utf8')) as { version: number; relations: Array<{ id?: string }> };
        expect(upgraded.version).toBe(2);
        expect(upgraded.relations).toHaveLength(2);
        expect(upgraded.relations.every((edge) => typeof edge.id === 'string' && edge.id.length > 0)).toBe(true);
        expect(new Set(upgraded.relations.map((edge) => edge.id)).size).toBe(2);
    });

    it('refuses a lifecycle cycle and an independent edge whose declared surfaces overlap', async () => {
        const root = await tempRoot('kata-lifecycle-safety-', ['initiative-child', 'other-child']);

        await addLifecycleRelation({
            root,
            from: { type: 'change', id: 'initiative' },
            to: { type: 'task', id: 'initiative-child' },
            type: 'contains',
            lifecycle: { initiativeId: 'initiative', policy: 'informs', requiredReturn: 'impact_packet' },
        });

        // A cycle: the child claiming to contain the initiative that contains it.
        await expect(addLifecycleRelation({
            root,
            from: { type: 'task', id: 'initiative-child' },
            to: { type: 'change', id: 'initiative' },
            type: 'contains',
            lifecycle: { initiativeId: 'initiative', policy: 'informs', requiredReturn: 'none' },
        })).rejects.toThrow(/cycle/);

        // `independent` is a claim about surfaces, so it is refused when the two endpoints declare an overlapping one.
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

    it('never reports a lifecycle edge without validated metadata as a plain relation', async () => {
        const root = await tempRoot('kata-lifecycle-metadata-', ['a', 'b']);

        // Written straight to disk, because that is how a drifted graph reaches a reader: through the file, not the writer.
        await writeFile(relationsPath(root), `${JSON.stringify({
            version: 2,
            relations: [
                {
                    id: 'edge-1',
                    kind: 'context',
                    type: 'related_to',
                    from: { type: 'change', id: 'initiative' },
                    to: { type: 'task', id: 'a' },
                    createdAt: '2026-10-03T00:00:00.000Z',
                    lifecycle: { initiativeId: 'initiative', policy: 'not_a_policy', requiredReturn: 'none' },
                },
            ],
            updatedAt: '2026-10-03T00:00:00.000Z',
        }, null, 2)}\n`, 'utf8');

        await expect(readKataRelations(root)).rejects.toThrow(/not_a_policy|lifecycle/);
        expect(await graphVersion(root)).toBe(2);
    });
});
