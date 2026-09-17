import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addTaskRelation, readTaskRelations, resolveTerminalTask } from '../../src/core/relations.js';

/**
 * One edge used to be written to three stores — the graph, `.kata/tasks/<id>/task-relations.json`, and `task.json` —
 * with reads preferring the per-task file and falling back to `task.json` on any error, so a failure between the writes
 * left them disagreeing and the fallback hid it. The graph is the store; these tests pin that, and pin that drift is
 * reported rather than answered with an empty relation list.
 */
describe('relation store', () => {
    const roots: string[] = [];

    afterEach(async () => {
        await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    });

    async function tempRoot(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-relation-store-'));
        roots.push(root);
        for (const taskId of ['from-task', 'to-task']) {
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

    async function exists(path: string): Promise<boolean> {
        try {
            await stat(path);
            return true;
        } catch {
            return false;
        }
    }

    it('records an edge once, in the graph, and touches nothing else', async () => {
        const root = await tempRoot();
        const before = await readFile(join(root, '.kata/tasks/from-task/task.json'), 'utf8');

        const record = await addTaskRelation({ root, fromTaskId: 'from-task', toTaskId: 'to-task', type: 'covered_by', reason: 'covered' });

        expect(record.relations).toEqual([
            { type: 'covered_by', targetTaskId: 'to-task', reason: 'covered', createdAt: expect.any(String) },
        ]);
        // The graph carries the edge…
        const graph = JSON.parse(await readFile(join(root, '.kata/relations.json'), 'utf8')) as { relations: unknown[] };
        expect(graph.relations).toHaveLength(1);
        // …and neither projection is written any more.
        expect(await exists(join(root, '.kata/tasks/from-task/task-relations.json'))).toBe(false);
        expect(await readFile(join(root, '.kata/tasks/from-task/task.json'), 'utf8')).toBe(before);
    });

    it('derives a task’s relations from the graph, in the task-relation shape', async () => {
        const root = await tempRoot();
        await addTaskRelation({ root, fromTaskId: 'from-task', toTaskId: 'to-task', type: 'depends_on' });
        await addTaskRelation({ root, fromTaskId: 'from-task', toTaskId: 'to-task', type: 'covered_by', createdBy: 'kata-cli' });

        const record = await readTaskRelations(root, 'from-task');

        expect(record.taskId).toBe('from-task');
        expect(record.relations).toEqual([
            expect.objectContaining({ type: 'depends_on', targetTaskId: 'to-task' }),
            expect.objectContaining({ type: 'covered_by', targetTaskId: 'to-task', createdBy: 'kata-cli' }),
        ]);
        // Only the task's own outgoing task relations belong to it.
        expect((await readTaskRelations(root, 'to-task')).relations).toEqual([]);
    });

    it('answers with no relations when no graph has been written', async () => {
        const root = await tempRoot();

        expect((await readTaskRelations(root, 'from-task')).relations).toEqual([]);
    });

    it('reports a drifted graph instead of falling back to another store', async () => {
        const root = await tempRoot();
        await addTaskRelation({ root, fromTaskId: 'from-task', toTaskId: 'to-task', type: 'covered_by' });
        await writeFile(join(root, '.kata/relations.json'), `${JSON.stringify({ version: 1, relations: [{ type: 'covered_by' }], updatedAt: 'now' })}\n`, 'utf8');

        await expect(readTaskRelations(root, 'from-task')).rejects.toThrow(/kata-relations artefact .*does not match its schema/);
    });

    it('follows terminal redirects through the graph and refuses a cycle', async () => {
        const root = await tempRoot();
        await addTaskRelation({ root, fromTaskId: 'from-task', toTaskId: 'to-task', type: 'superseded_by', reason: 'replaced' });

        expect(await resolveTerminalTask(root, 'from-task')).toMatchObject({
            taskId: 'to-task',
            redirects: [{ fromTaskId: 'from-task', toTaskId: 'to-task', type: 'superseded_by', reason: 'replaced' }],
        });

        await addTaskRelation({ root, fromTaskId: 'to-task', toTaskId: 'from-task', type: 'superseded_by' });
        await expect(resolveTerminalTask(root, 'from-task')).rejects.toThrow(/cycle/);
    });
});
