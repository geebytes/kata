import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTask } from '../../src/core/task.js';
import { addKataRelation, addLifecycleRelation, readKataRelations } from '../../src/core/relations.js';
import { relationsPath } from '../../src/core/layout.js';

/**
 * **AC-1: lifecycle relations extend the one authoritative graph.**
 *
 * `.kata/relations.json` is already the sole topology, so an Initiative is an endpoint in it rather than a second graph
 * beside it. What the graph could not express is the lifecycle dimension: `KataRelation` had no stable `id`, and edges
 * are replaced by `(from, to, type)` — so a lifecycle record that needed to point at "one particular relation" would have
 * to fingerprint the endpoints, and a fingerprint breaks the first time the edge is rewritten.
 *
 * A v1 graph has no ids and is **readable**, not drifted: every graph written before this change is v1. The migration
 * happens once, inside the first locked write, because minting ids on read would let two readers disagree about the
 * identity of the same edge.
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
