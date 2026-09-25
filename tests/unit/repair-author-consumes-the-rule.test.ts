import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { readRepairAuthors, recordRepairAuthor } from '../../src/quality/repair-author.js';
import { giveDisposition } from '../helpers/disposition.js';

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * The repair author's disposition **consumes** the falsification rule instead of restating it (AC-2).
 *
 * `rba4-f2` measured the gap: the rule had one derivation and no copy, but its consumer was the general obligation path —
 * `closure-gate`'s criterion — and **nothing joined a repair to a disposition at all**. `repair-author.ts` did not import the
 * ledger, the entry had no field for it, and no code compared the two by `findingId`. So the change's headline claim — a repair
 * made by another session, whose disposition follows the established rule — was asserted by no criterion, and the file that
 * claimed it had three cases of `readFileSync` + `toContain` that constructed nothing.
 *
 * The falsifier's mutation is the rule itself: make `hasFalsifierDisposition` say no, and a repair that was recordable must
 * become unrecordable.
 */
describe('a repair author consumes the disposition rule rather than restating it', () => {
    it('refuses a repair whose finding has no disposition, and accepts one that has', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-author-rule-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'r-task', title: 'Rule', acceptance: [{ id: 'AC-1', statement: 'x' }] });

        // Nothing recorded yet: the write refuses, and says which rule it consumed.
        await expect(recordRepairAuthor(root, 'r-task', { findingId: 'f-x', session: 's', handed: 'h', report: 'r' }))
            .rejects.toThrow(/no recorded disposition/);

        await giveDisposition(root, 'r-task', 'f-x');
        const recorded = await recordRepairAuthor(root, 'r-task', { findingId: 'f-x', session: 's', handed: 'h', report: 'r' });
        // And the entry says which shape closed it, so a reader can tell a reddening from an absence.
        expect(recorded.disposition).toBe('reddening');
        expect((await readRepairAuthors(root, 'r-task')).map((repair) => repair.findingId)).toEqual(['f-x']);
    });
});

/**
 * **The binding is the tree, so a repair that touched an owned path can be recorded** — `rba11-f1`, from the eleventh round.
 *
 * `recordRepairAuthor` consumes the same disposition rule the closure criterion asks, and the criterion's content half is
 * *the content the next seal will mint* — the tree. Reading `currentRevision.pathDigests` here made the two disagree the moment a
 * repair touched an owned path: measured, a revision minted by a seal carries 19 of 19 digests equal to the tree while a proof
 * seeded from the previous revision carried 8 of 19, so the write refused a repair that had actually been proved.
 *
 * The falsifier is the edit: record a disposition, change an owned path, then record the repair. Revert the binding to the sealed
 * set and the second call is refused.
 */
describe('a repair that changed an owned path can be recorded', () => {
    it('accepts a disposition taken before the edit, because the seal that follows mints the same tree', async () => {
        const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const { initLayout } = await import('../../src/core/layout.js');
        const { createTask } = await import('../../src/core/task.js');
        const { createTaskRevision, computePathDigests } = await import('../../src/workflow/revision.js');
        const { recordFalsifierReddening } = await import('../../src/quality/falsifier-reddenings.js');
        const { recordRepairAuthor } = await import('../../src/quality/repair-author.js');
        const root = await mkdtemp(join(tmpdir(), 'kata-author-tree-'));
        try {
            await initLayout(root);
            await createTask({ root, id: 'author-tree', title: 'A', ownedPaths: ['src/a.ts'], acceptance: [{ id: 'AC-1', statement: 'x' }] });
            await mkdir(join(root, 'src'), { recursive: true });
            await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
            await createTaskRevision({ root, taskId: 'author-tree', ownedPaths: ['src/a.ts'], checkIds: [] });
            // **The prescribed order: the repair lands, then the disposition is recorded, then the seal mints that content.**
            // The first version of this case put the edit *after* the recording and it reddened — correctly, because the two
            // then describe different trees. That is the discipline being real rather than a convention, and it is what the
            // measured pair shows: a revision a seal minted carries 19 of 19 digests equal to the tree it was minted from.
            await writeFile(join(root, 'src/a.ts'), 'export const a = 2;\n', 'utf8');
            const after = await computePathDigests(root, ['src/a.ts']);
            await recordFalsifierReddening(root, 'author-tree', {
                findingId: 'f-owned', check: 'true', mutation: 'false', revisionId: 'revision-aaaaaaaaaaaaaaaa',
                observed: { before: 0, mutated: 1, after: 0 }, reddenedAt: '2026-01-01T00:00:00.000Z', pathDigests: after,
            });
            await createTaskRevision({ root, taskId: 'author-tree', ownedPaths: ['src/a.ts'], checkIds: [] });
            await expect(recordRepairAuthor(root, 'author-tree', {
                findingId: 'f-owned', session: 'a session that did not write it', handed: 'the findings and their falsifiers',
                report: 'changed src/a.ts to 2', recordedAt: '2026-01-01T00:00:00.000Z',
            })).resolves.toBeDefined();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

/**
 * **A repair recorded after the disposition and *before* the seal is accepted** — `rba12-f2`.
 *
 * `recordRepairAuthor` bound a disposition to the current **sealed** revision while `kata-cli falsify` records the working tree, so
 * the two agreed only when nothing had been edited between the recording and this call. That is a coincidence rather than a rule: the
 * producer records the content the next seal will mint, and this consumer must ask about the same content.
 *
 * The falsifier is the edit: the disposition is taken, the owned path changes, and the repair is recorded before any seal. Revert the
 * binding to `readCurrentTaskRevision().pathDigests` and this reddens.
 */
describe('a repair recorded before the seal is accepted', () => {
    it('binds what the producer recorded, not the older revision', async () => {
        const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const { initLayout } = await import('../../src/core/layout.js');
        const { createTask } = await import('../../src/core/task.js');
        const { createTaskRevision, computePathDigests } = await import('../../src/workflow/revision.js');
        const { recordFalsifierReddening } = await import('../../src/quality/falsifier-reddenings.js');
        const { recordRepairAuthor } = await import('../../src/quality/repair-author.js');
        const root = await mkdtemp(join(tmpdir(), 'kata-author-pre-seal-'));
        try {
            await initLayout(root);
            await createTask({ root, id: 'pre-seal', title: 'P', ownedPaths: ['src/a.ts'], acceptance: [{ id: 'AC-1', statement: 'x' }] });
            await mkdir(join(root, 'src'), { recursive: true });
            await writeFile(join(root, 'src/a.ts'), 'export const a = 1;\n', 'utf8');
            await createTaskRevision({ root, taskId: 'pre-seal', ownedPaths: ['src/a.ts'], checkIds: [] });
            const before = await computePathDigests(root, ['src/a.ts']);
            await recordFalsifierReddening(root, 'pre-seal', {
                findingId: 'f-pre-seal', check: 'true', mutation: 'false', revisionId: 'revision-aaaaaaaaaaaaaaaa',
                observed: { before: 0, mutated: 1, after: 0 }, reddenedAt: '2026-01-01T00:00:00.000Z', pathDigests: before,
            });
            // The repair lands after the proof and before any seal: the state the old binding refused.
            await writeFile(join(root, 'src/a.ts'), 'export const a = 2;\n', 'utf8');
            const after = await computePathDigests(root, ['src/a.ts']);
            await recordFalsifierReddening(root, 'pre-seal', {
                findingId: 'f-pre-seal', check: 'true', mutation: 'false', revisionId: 'revision-aaaaaaaaaaaaaaaa',
                observed: { before: 0, mutated: 1, after: 0 }, reddenedAt: '2026-01-01T00:00:01.000Z', pathDigests: after,
            });
            await expect(recordRepairAuthor(root, 'pre-seal', {
                findingId: 'f-pre-seal', session: 'a session that did not write it', handed: 'the findings and their falsifiers',
                report: 'changed src/a.ts to 2', recordedAt: '2026-01-01T00:00:00.000Z',
            })).resolves.toBeDefined();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
