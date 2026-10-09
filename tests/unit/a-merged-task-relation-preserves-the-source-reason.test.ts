import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **AC-23 — consolidating work into one successor preserves what the consolidated tasks recorded.**
 *
 * The migration existed as a command run once; this is the property it has to have left behind. Three facts, each of which
 * was missing or thin at some point while it was being done:
 *
 * 1. **Every source names a successor, and the successor names nothing back into them.** A `merged_into` edge per source, so
 *    a reader who arrives at a consolidated task is told where its work went rather than finding it abandoned.
 * 2. **The edge carries the audit.** A generic reason ("merged") is not an audit trail: it says the task was consolidated and
 *    nothing about *what* was carried, so the revision and the findings the edge is about have to be named on it. Measured on
 *    the first run of this migration: all fourteen edges carried one identical sentence, which told a later reader nothing.
 * 3. **Nothing was erased.** Each source task still exists with its records, and this change's own task carries the
 *    reproduced defects as acceptance criteria rather than restating them in prose.
 *
 * It reads the live relation store, which is the artefact under test: this is a fact about this repository's own governance
 * record, not about a module's behaviour, so a fixture root would be asserting about a copy nobody made.
 */
const SUCCESSOR = 'unify-the-remaining-integrity-and-workflow-gaps';
const root = process.cwd();

type Edge = {
    id?: string;
    type?: string;
    from?: { type?: string; id?: string };
    to?: { type?: string; id?: string };
    reason?: string;
    createdAt?: string;
};

describe('the consolidation preserved its sources', () => {
    it('names a successor for every consolidated task, with the revision and findings it carried', async () => {
        const graph = JSON.parse(await readFile(join(root, '.kata', 'relations.json'), 'utf8')) as { relations: Edge[] };
        const merged = graph.relations.filter((edge) => edge.type === 'merged_into' && edge.to?.id === SUCCESSOR);

        // There is more than one, or this case is about nothing.
        expect(merged.length).toBeGreaterThan(1);
        for (const edge of merged) {
            const source = edge.from?.id ?? '';
            expect(source.length).toBeGreaterThan(0);
            // **The audit is on the edge.** A later reader has to be able to tell what this consolidation carried without
            // opening both task directories and reconstructing it.
            expect(edge.reason, `${source} names its revision`).toMatch(/revision-[0-9a-f]{8,}/);
            expect(edge.reason, `${source} names what it carried`).toMatch(/finding|reproduced defect|recorded round/);
            // Nothing points back: a consolidation is not a mutual relation, and a back-edge would read as "these are two
            // live tasks that happen to be related".
            expect(graph.relations.some((other) => other.type === 'merged_into' && other.from?.id === SUCCESSOR && other.to?.id === source)).toBe(false);
        }
    });

    it('leaves every source task in place, with the records it had', async () => {
        const graph = JSON.parse(await readFile(join(root, '.kata', 'relations.json'), 'utf8')) as { relations: Edge[] };
        const sources = graph.relations
            .filter((edge) => edge.type === 'merged_into' && edge.to?.id === SUCCESSOR)
            .map((edge) => edge.from?.id ?? '');

        for (const source of sources) {
            const files = await readdir(join(root, '.kata', 'tasks', source));
            // The task record and its own history, not an empty husk left behind by a move.
            expect(files, `${source} still holds its records`).toContain('task.json');
        }
    });

    it('carries the reproduced defects as acceptance criteria, rather than as a sentence ', async () => {
        const task = JSON.parse(await readFile(join(root, '.kata', 'tasks', SUCCESSOR, 'task.json'), 'utf8')) as {
            acceptance: Array<{ id: string; statement: string }>;
            acceptanceMatrix?: { rows: Array<{ acceptanceId: string; testPaths?: string[] }> };
        };

        // The consolidated work is a contract here: every criterion has a selector, which is what makes "the successor owns
        // these defects" checkable rather than asserted.
        expect(task.acceptance.length).toBeGreaterThan(15);
        const rows = task.acceptanceMatrix?.rows ?? [];
        expect(rows.length).toBe(task.acceptance.length);
        for (const row of rows) {
            expect(row.testPaths ?? [], `${row.acceptanceId} has a selector`).not.toHaveLength(0);
        }
    });
});
