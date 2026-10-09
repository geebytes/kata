import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { addTaskRelation, readKataRelations } from '../../src/core/relations.js';

/**
 * **AC-23 — consolidating work into one successor preserves what the consolidated tasks recorded.**
 *
 * Three facts, each of which was missing or thin while the migration was being done:
 *
 * 1. **The edge carries the audit.** A generic reason ("merged") says a task was consolidated and nothing about *what* was
 *    carried, so the revision and the findings have to be named on the edge. Measured on the first run of this migration: all
 *    fourteen edges carried one identical sentence, which told a later reader nothing.
 * 2. **Nothing points back.** A consolidation is not a mutual relation, and a back-edge would read as "two live tasks that
 *    happen to be related".
 * 3. **Nothing is erased.** The source task keeps its own records; the successor carries the work.
 *
 * **Driven through the managed writer on a fixture root, not by reading this repository's own store.** The first version of
 * this case read `.kata/relations.json` and the task directories of the live checkout — which is the rule this very change
 * exists to enforce (a test that reads the live store measures the store, and the seal's snapshot deliberately excludes it:
 * measured, the case failed inside the seal's isolated execution snapshot while passing in the working tree).
 */
const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; source: string; successor: string }> {
    const root = await mkdtemp(join(tmpdir(), 'kata-merge-'));
    roots.push(root);
    await initLayout(root);
    const source = 'consolidated-change';
    const successor = 'the-successor';
    for (const id of [source, successor]) {
        await mkdir(join(root, '.kata', 'tasks', id), { recursive: true });
        await writeFile(join(root, '.kata', 'tasks', id, 'task.json'), `${JSON.stringify({ id, phase: 'review', acceptance: [] })}\n`);
    }
    return { root, source, successor };
}

describe('the consolidation preserves its sources', () => {
    it('names the successor with the revision and findings the edge is about, and points nothing back', async () => {
        const { root, source, successor } = await fixture();
        const reason = 'Consolidated into the successor. Audit carried forward: revision revision-abc12345; its recorded round holds 2 finding(s) (major, minor): R1-F1, R1-F2.';

        await addTaskRelation({ root, fromTaskId: source, toTaskId: successor, type: 'merged_into', reason });

        const graph = await readKataRelations(root);
        const edge = graph.relations.find((relation) => relation.type === 'merged_into' && relation.reason?.includes('revision-abc12345'));
        expect(edge, JSON.stringify(graph.relations)).toBeDefined();
        // The same type the live migration used, driven through the managed writer rather than by editing the store.
        expect(edge?.from.id).toBe(source);
        // **The audit is on the edge.** A reader who arrives at the consolidated task is told what it carried without
        // reconstructing it from two directories.
        expect(edge?.reason).toMatch(/revision-[0-9a-f]{8,}/);
        expect(edge?.reason).toMatch(/finding/);
        expect(graph.relations.some((relation) => relation.from.id === successor)).toBe(false);
    });

    it('leaves the source task in place, with the records it had', async () => {
        const { root, source, successor } = await fixture();
        await addTaskRelation({
            root,
            fromTaskId: source,
            toTaskId: successor,
            type: 'merged_into',
            reason: 'Consolidated: revision revision-abc12345; its recorded round holds 1 finding (major): R1-F1.',
        });

        // A consolidation is a relation, not a move: the source is still a task with its own record.
        const files = await readdir(join(root, '.kata', 'tasks', source));
        expect(files).toContain('task.json');
        const record = JSON.parse(await readFile(join(root, '.kata', 'tasks', source, 'task.json'), 'utf8')) as { id: string };
        expect(record.id).toBe(source);
        // And the successor is named by the relation, not by rewriting the source's record.
        expect(record).not.toHaveProperty('mergedInto');
    });
});
