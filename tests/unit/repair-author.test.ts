import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { giveDisposition } from '../helpers/disposition.js';
import { hasRecordedAuthor, readRepairAuthors, recordRepairAuthor } from '../../src/quality/repair-author.js';

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-author-'));
    roots.push(root);
    await initLayout(root);
    await createTask({ root, id: 'a-task', title: 'Author', acceptance: [{ id: 'AC-1', statement: 'x' }] });
    return root;
}

/**
 * AC-1, in the scope it can honestly have. There is no recorded identity to compare a repair against — checked while designing
 * this change: a handoff records `platform`, which is `"pi"` for every session on this machine, and nothing records a session
 * identity, deliberately. So what is asserted is what the record can carry and a reader can act on: which session made the
 * repair, what it was handed, and the ceiling stated rather than hidden.
 */
describe('a repair records who made it and what they were handed', () => {
    it('records it, reads it back, and states the ceiling in the record itself', async () => {
        const root = await workspace();
        await giveDisposition(root, 'a-task', 'f-1');
        await recordRepairAuthor(root, 'a-task', {
            findingId: 'f-1',
            session: 'kata-implementer (fresh, read+write in a scratch copy)',
            handed: 'the finding, its falsifier, and the scratch copy it may write in',
            report: 'changed src/x.ts; the falsifier reddened before the repair and passed after',
        });

        const [recorded] = await readRepairAuthors(root, 'a-task');
        expect(recorded?.findingId).toBe('f-1');
        expect(recorded?.session).toContain('kata-implementer');
        // The ceiling is in the record, not in a document about the record: a reader who sees provenance should see its limit.
        expect(recorded?.ceiling).toContain('not proof');
        expect(hasRecordedAuthor(await readRepairAuthors(root, 'a-task'), 'f-1')).toBe(true);
        expect(hasRecordedAuthor(await readRepairAuthors(root, 'a-task'), 'f-other')).toBe(false);
    });

    it('re-recording a finding replaces its author rather than adding a second', async () => {
        const root = await workspace();
        await giveDisposition(root, 'a-task', 'f-1');
        await recordRepairAuthor(root, 'a-task', { findingId: 'f-1', session: 'first', handed: 'h', report: 'r' });
        await giveDisposition(root, 'a-task', 'f-1');
        await recordRepairAuthor(root, 'a-task', { findingId: 'f-1', session: 'second', handed: 'h', report: 'r' });

        const repairs = await readRepairAuthors(root, 'a-task');
        expect(repairs).toHaveLength(1);
        expect(repairs[0]?.session).toBe('second');
    });
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
