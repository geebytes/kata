import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * **The graph moves mid-read, deterministically.** A dependency answer is assembled from four files written by different
 * writers under different locks, so the state it describes may be one no moment ever held. Simulating that needs a writer
 * landing *between* two of the reads, which the filesystem cannot be asked to do on cue — so the graph reader is wrapped,
 * the real one still answers, and only the `updatedAt` it reports is advanced. The edges stay the fixture's own, which is
 * what makes the assertion about the generation check rather than about a synthetic graph.
 */
const graphReads = { count: 0, bumpEveryRead: false };
vi.mock('../../src/core/relations.js', async (importOriginal) => {
    const original = await importOriginal<typeof import('../../src/core/relations.js')>();
    return {
        ...original,
        readKataRelations: async (...args: Parameters<typeof original.readKataRelations>) => {
            const graph = await original.readKataRelations(...args);
            graphReads.count += 1;
            // `bumpEveryRead` keeps the race alive so the refusal is reachable; otherwise the graph settles after the first
            // moved read, which is the ordinary case a retry recovers from.
            if (graphReads.bumpEveryRead || graphReads.count === 2) {
                return { ...graph, updatedAt: `2026-01-01T00:00:0${Math.min(graphReads.count, 9)}.000Z` };
            }
            return graph;
        },
    };
});

import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { addKataRelation } from '../../src/core/relations.js';
import { movedGenerations, readTaskDependency, type DependencyGeneration } from '../../src/workflow/task-dependency.js';

const roots: string[] = [];

function write(root: string, relativePath: string, content: string): void {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
}

async function fixture(name: string, options: { edge?: boolean } = {}): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), `kata-generation-${name}-`));
    roots.push(root);
    await initLayout(root);
    write(root, 'src/a.ts', 'export const holds = true;\n');
    await createTask({ root, id: 'dependent', title: 'd', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['src/a.ts'] });
    await createTask({ root, id: 'corrective', title: 'c', acceptance: [{ id: 'AC-1', statement: 'x' }], ownedPaths: ['src/a.ts'] });
    if (options.edge !== false) {
        await addKataRelation({
            root,
            from: { type: 'task', id: 'dependent' },
            to: { type: 'task', id: 'corrective' },
            type: 'blocked_by',
            reason: 'the mechanism this change depends on',
        });
    }
    graphReads.count = 0;
    graphReads.bumpEveryRead = false;
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('a dependency is read as one state', () => {
    it('recovers when a writer lands mid-read, and answers from the settled state', async () => {
        const root = await fixture('recovers');
        const decision = await readTaskDependency(root, 'dependent');

        // One retry was enough: the answer is the ordinary pending decision, not a refusal.
        expect(decision.state).toBe('pending');
        expect(decision.blockers[0]?.reason).toBe('corrective_not_certified');
        // The first attempt lost the race (read 1 vs read 2 differ) and the second attempt read twice in agreement.
        expect(graphReads.count).toBeGreaterThanOrEqual(4);
    });

    it('refuses rather than answering when the race does not settle', async () => {
        const root = await fixture('unsettled');
        graphReads.bumpEveryRead = true;

        const decision = await readTaskDependency(root, 'dependent');
        expect(decision.state).toBe('undetermined');
        expect(decision.blockers[0]?.reason).toBe('records_moved_while_reading');
        // The refusal says *what* moved, so an operator can tell a busy repository from a broken one.
        expect(decision.blockers[0]?.detail).toContain('the relation graph');
        expect(decision.blockers[0]?.detail).toContain('changed while it was being read, twice');
        // And its road is a command that exists.
        expect(decision.blockers[0]?.road).toBe('kata-cli dependency status --change dependent');
        // Bounded: two attempts, each reading the graph twice, and then it stops.
        expect(graphReads.count).toBe(4);
    });

    it('costs nothing extra for a task no edge claims, because there is no state to mix', async () => {
        const root = await fixture('no-edge', { edge: false });
        const decision = await readTaskDependency(root, 'dependent');
        expect(decision.state).toBe('absent');
        expect(graphReads.count, 'an edge-less task reads the graph once and returns').toBe(1);
    });

    it('names every generation that moved, not just the graph', () => {
        const base: DependencyGeneration = {
            graphUpdatedAt: 'g1',
            returnsUpdatedAt: 'r1',
            subjectRevisionId: 'rev-d1',
            correctiveRevisionIds: { corrective: 'rev-c1', other: null },
        };
        expect(movedGenerations(base, base)).toEqual([]);

        expect(movedGenerations(base, { ...base, graphUpdatedAt: 'g2' }))
            .toEqual(['the relation graph (updatedAt g1 -> g2)']);
        expect(movedGenerations(base, { ...base, returnsUpdatedAt: null }))
            .toEqual(['the dependency return record (updatedAt r1 -> <none>)']);
        expect(movedGenerations(base, { ...base, subjectRevisionId: 'rev-d2' }))
            .toEqual(["this task's own revision (rev-d1 -> rev-d2)"]);
        // The corrective action re-sealing is the case the whole mechanism exists for, and it is named by task.
        expect(movedGenerations(base, { ...base, correctiveRevisionIds: { corrective: 'rev-c2', other: null } }))
            .toEqual(["the corrective task 'corrective' (revision rev-c1 -> rev-c2)"]);
        // A corrective action appearing or disappearing from the pointer is the same fact as it moving.
        expect(movedGenerations(base, { ...base, correctiveRevisionIds: { corrective: 'rev-c1', other: 'rev-o1' } }))
            .toEqual(["the corrective task 'other' (revision <none> -> rev-o1)"]);
    });
});
