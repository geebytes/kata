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
