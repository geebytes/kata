import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addKataRelation, type KataRelationsGraph } from '../../src/core/relations.js';

/**
 * L3-02: the relation graph is the authoritative store, so a lost update is a lost terminal relation.
 *
 * The measured failure is a bare read-modify-write: two commands add an edge, both read the same graph, both write, and
 * the second write silently discards the first edge. Nothing reports it, because the file is still valid JSON.
 */
describe('relation graph concurrency', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    /** `addKataRelation` refuses an endpoint whose task record is missing, so the fixture has to create them. */
    async function tempRoot(prefix: string, taskIds: string[]): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), prefix));
        roots.push(root);
        for (const taskId of taskIds) {
            await mkdir(join(root, '.kata/tasks', taskId), { recursive: true });
            await writeFile(join(root, '.kata/tasks', taskId, 'task.json'), `${JSON.stringify({
                id: taskId,
                title: taskId,
                phase: 'implement',
                acceptance: [{ id: 'AC-1', statement: 'x' }],
                createdAt: '2026-09-17T00:00:00.000Z',
                updatedAt: '2026-09-17T00:00:00.000Z',
            })}\n`, 'utf8');
        }
        return root;
    }

    it('keeps every edge when two writers race, or refuses the second with a reason', async () => {
        const root = await tempRoot('kata-relations-', ['a', 'b', 'target']);

        const edge = (id: string) => addKataRelation({
            root,
            from: { type: 'task', id },
            to: { type: 'task', id: 'target' },
            type: 'related_to',
            createdBy: 'test',
        });

        const results = await Promise.allSettled([edge('a'), edge('b')]);
        const graph = JSON.parse(await readFile(join(root, '.kata/relations.json'), 'utf8')) as KataRelationsGraph;

        // Either both edges landed, or one writer was told the lock was held. Neither case may end with one edge
        // silently missing, which is what the unlocked version produced.
        const refusals = results.filter((result) => result.status === 'rejected');
        refusals.forEach((result) => expect(String((result as PromiseRejectedResult).reason)).toMatch(/Another kata process is mutating relations/));
        expect(graph.relations).toHaveLength(2 - refusals.length);
    });

    it('refuses a mutation over a drifted graph instead of compounding it', async () => {
        const root = await tempRoot('kata-relations-drift-', ['a', 'b']);
        // Drifted *and* shaped: every required field is present, so the failure names the bad edge rather than a
        // missing envelope field. That is the error a reader can act on.
        await writeFile(join(root, '.kata/relations.json'), JSON.stringify({
            version: 1,
            updatedAt: 'now',
            relations: [{ kind: 'lineage', type: 'related_to', from: { type: 'task', id: 'a' }, to: { type: 'task', id: 'b' }, createdAt: 'now', nonsense: true }],
        }), 'utf8');

        await expect(addKataRelation({
            root,
            from: { type: 'task', id: 'a' },
            to: { type: 'task', id: 'b' },
            type: 'related_to',
            createdBy: 'test',
        // The plan expected `/does not match its schema/`, which is the wording of `readValidated`. This path validates
        // inside the mutation, so the error is the bare rendered violation — and a better one: it names the offending
        // path (`$.relations[0].nonsense`) instead of the file.
        })).rejects.toThrow(/\$\.relations\[0\]\.nonsense is not allowed/);
    });

    it('writes a first edge to a repository that has no graph yet, without validating a seed that no schema accepts', async () => {
        // The seed has no `updatedAt` because no graph was ever written. Validating it would make every first write
        // fail on a file that does not exist — so the schema is applied to what is on disk, not to the placeholder.
        const root = await tempRoot('kata-relations-first-', ['a', 'b']);

        const graph = await addKataRelation({
            root,
            from: { type: 'task', id: 'a' },
            to: { type: 'task', id: 'b' },
            type: 'related_to',
            createdBy: 'test',
        });

        expect(graph.relations).toHaveLength(1);
        const onDisk = JSON.parse(await readFile(join(root, '.kata/relations.json'), 'utf8')) as KataRelationsGraph;
        expect(onDisk.updatedAt).toBeTruthy();
    });
});
