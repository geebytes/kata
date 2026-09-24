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

