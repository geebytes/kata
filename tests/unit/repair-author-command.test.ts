import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { giveDisposition } from '../helpers/disposition.js';
import { runRepairAuthorCommand } from '../../src/cli/repair-author.js';

const roots: string[] = [];
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * `rba-f4`'s repair, and it is tested **behaviourally** — the command writes a record and reads it back — rather than by
 * asserting that certain strings appear in certain files, which is the shape `rba-f3` named as a check that does not test its
 * criterion.
 *
 * The finding said the provenance record had no producer and no consumer in the tool. The cost of that was demonstrated the
 * same day: a repair author was dispatched, investigated for nineteen minutes, wrote nothing, and there was nothing that could
 * have received a report even if it had.
 */
async function workspace(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-author-cmd-'));
    roots.push(root);
    await initLayout(root);
    await createTask({ root, id: 'c-task', title: 'Command', acceptance: [{ id: 'AC-1', statement: 'x' }] });
    return root;
}

describe('the repair-author command produces and consumes the provenance record', () => {
    it('records a report and reads it back, from the command rather than from a test', async () => {
        const root = await workspace();
        // A disposition is a precondition of a repair author, not an optional companion: the write consumes the falsification
        // rule, so a repair has to have been shown to work before anyone can be recorded as having done it.
        await giveDisposition(root, 'c-task', 'f-1');
        const previous = process.cwd();
        process.chdir(root);
        try {
            const recorded = await runRepairAuthorCommand([
                'record', '--change', 'c-task', '--finding', 'f-1',
                '--session', 'kata-implementer (worktree)',
                '--handed', 'the finding, its falsifier, and a scratch worktree',
                '--report', 'changed src/x.ts; the falsifier reddened before and passed after',
            ]);
            expect(recorded.success).toBe(true);

            const listed = await runRepairAuthorCommand(['list', '--change', 'c-task']);
            const repairs = listed.repairs as Array<{ findingId: string; session: string; ceiling: string }>;
            expect(repairs).toHaveLength(1);
            expect(repairs[0]?.findingId).toBe('f-1');
            expect(repairs[0]?.session).toContain('kata-implementer');
            // The ceiling travels with the record, so a reader sees provenance and its limit together.
            expect(repairs[0]?.ceiling).toContain('not proof');
        } finally {
            process.chdir(previous);
        }
    });

    it('refuses to record without the three facts the record exists to carry', async () => {
        const root = await workspace();
        const previous = process.cwd();
        process.chdir(root);
        try {
            const refused = await runRepairAuthorCommand(['record', '--change', 'c-task', '--finding', 'f-1']);
            expect(refused.success).toBe(false);
            // It names what is missing rather than writing a record that cannot say who made the repair.
            expect(String(refused.error)).toContain('--session');
            expect(String(refused.error)).toContain('--handed');
            expect(String(refused.error)).toContain('--report');
        } finally {
            process.chdir(previous);
        }
    });
});
