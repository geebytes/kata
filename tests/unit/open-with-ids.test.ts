import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { runCommand } from '../../src/workflow/orchestrator.js';

/**
 * Ids are checked where they are supplied.
 *
 * Both mistakes here used to surface much later: an acceptance id that is not kata's numbering failed at seal, and an
 * upstream requirement id from a real document (AC-R1, GUARD-3, SLICE-S2) was rejected by the schema when the record
 * was written — after the author had mapped every requirement. One rule per id kind, applied at the point of entry.
 */
describe('opening a task with caller-supplied ids', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function tempRoot(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-open-ids-'));
        roots.push(root);
        await initLayout(root);
        return root;
    }

    it('accepts the identifiers a real upstream document uses', async () => {
        const root = await tempRoot();
        const result = await runCommand('open', 'real-doc-ids', root, {
            acceptance: [{ id: 'AC-1', statement: 'Ship it.' }],
            requirements: [
                { id: 'AC-R1', statement: 'Identity is content-derived.' },
                { id: 'GUARD-3', statement: 'A gate names its remedy.' },
                { id: 'SLICE-S2', statement: 'Slices land in order.' },
            ],
        });

        expect(result).toMatchObject({ success: true });
        const task = JSON.parse(await readFile(join(root, '.kata/tasks/real-doc-ids/task.json'), 'utf8')) as {
            requirements?: Array<{ id?: string }>;
        };
        expect(task.requirements?.map((entry) => entry.id)).toEqual(['AC-R1', 'GUARD-3', 'SLICE-S2']);
    });

    it('refuses an acceptance id that is not kata’s numbering', async () => {
        const root = await tempRoot();
        await expect(runCommand('open', 'bad-ac-id', root, {
            acceptance: [{ id: 'AC-R1', statement: 'Ship it.' }],
        })).rejects.toThrow(/Invalid acceptance id: AC-R1/);
    });

    it('refuses a requirement id that is not an identifier', async () => {
        const root = await tempRoot();
        await expect(runCommand('open', 'bad-req-id', root, {
            requirements: [{ id: 'not an id', statement: 'Something.' }],
        })).rejects.toThrow(/Invalid upstream requirement id: not an id/);
    });
});
