import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { createTaskRevision, readCurrentTaskRevision, computePathDigests } from '../../src/workflow/revision.js';

/**
 * **The rule, made checkable: a disposition must record the content the next seal will mint — and the next seal mints the tree.**
 *
 * Measured both ways on `kata-gate-surface`. `revision-71ed04c4248be3fe`, minted by a seal, has **19 of 19** digests equal to the
 * working tree; a proof seeded from the *previous* revision's frozen set had **8 of 19**, because 11 paths had moved. I changed the
 * recorder to the revision's set and it was wrong — it made the recorder disagree with the criterion for exactly the reason the
 * ordering discipline exists: *record, then seal immediately*.
 *
 * This test is the rule rather than a fixture for it: after a revision exists and its file moves, **the tree the next seal would
 * mint differs from the revision on disk**, which is why a proof must record the tree and why a seal must follow the recording
 * immediately. Revert either half — record the sealed set, or have the preflight compare the sealed set — and the pair of consumers
 * disagree again.
 */
describe('a disposition records the tree the next seal will mint', () => {
    it('is the tree, not the revision on disk, once the file has moved', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-record-tree-'));
        try {
            await initLayout(root);
            await createTask({ root, id: 'record-tree', title: 'R', ownedPaths: ['src/a.ts'], acceptance: [{ id: 'AC-1', statement: 'x' }] });
            await mkdir(join(root, 'src'), { recursive: true });
            await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
            await createTaskRevision({ root, taskId: 'record-tree', ownedPaths: ['src/a.ts'], checkIds: [] });
            const sealed = (await readCurrentTaskRevision(root, 'record-tree'))?.pathDigests ?? {};
            // The repair lands after the revision was sealed: this is the state in which a recorder must write the tree, because the
            // seal that follows it mints from the tree.
            await writeFile(join(root, 'src/a.ts'), 'export const a = 2;\n', 'utf8');
            const tree = await computePathDigests(root, ['src/a.ts']);
            expect(tree['src/a.ts']).not.toBe(sealed['src/a.ts']);
            // And what a seal mints now equals the tree — the property the recorder depends on.
            await createTaskRevision({ root, taskId: 'record-tree', ownedPaths: ['src/a.ts'], checkIds: [] });
            const minted = (await readCurrentTaskRevision(root, 'record-tree'))?.pathDigests ?? {};
            expect(minted['src/a.ts']).toBe(tree['src/a.ts']);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
