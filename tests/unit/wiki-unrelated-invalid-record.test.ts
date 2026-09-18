import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { createContextPacket } from '../../src/workflow/context-fabric.js';

/**
 * One broken record does not block a task that has nothing to do with it.
 *
 * Measured in this workspace: a record carrying a field the schema does not allow (`revalidatedBy`) blocked **every**
 * workflow mutation, because the handoff path read the whole Wiki strictly — the closure gate had been made tolerant,
 * but `wiki/context.ts` and `workflow/handoff.ts` had not. A record that cannot be read cannot be authoritative, so the
 * reader skips it and names it; only the Wiki's own validation surfaces are in the business of refusing.
 */
describe('an unrelated invalid Wiki record', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function workspace(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-wiki-invalid-'));
        roots.push(root);
        await initLayout(root);
        await createTask({ root, id: 'unrelated-record', title: 'Unrelated record', acceptance: [{ id: 'AC-1', statement: 'It still works.' }] });
        await mkdir(join(root, '.kata/wiki'), { recursive: true });
        // Exactly the shape measured: a field the schema does not allow.
        await writeFile(
            join(root, '.kata/wiki/llmwiki-legacy-page.json'),
            JSON.stringify({
                id: 'llmwiki-legacy-page',
                statement: 'A page from an older schema.',
                scope: ['docs/legacy.md'],
                kind: 'convention',
                sourceRefs: ['docs/legacy.md'],
                sourceHashes: { 'docs/legacy.md': 'a'.repeat(64) },
                validationTaskId: 'some-other-task',
                evidenceIds: [],
                status: 'verified',
                lastVerifiedAt: new Date().toISOString(),
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                revalidatedBy: 'a-field-the-schema-does-not-allow',
            }),
            'utf8',
        );
        return root;
    }

    it('does not stop the handoff packet from being built', async () => {
        const root = await workspace();

        const packet = await createContextPacket({
            root,
            taskId: 'unrelated-record',
            fromRole: 'implementer',
            toRole: 'reviewer',
        });

        expect(packet.id).toMatch(/^handoff-/);
        // …and the record is neither authoritative nor silently forgotten: it is named.
        expect(packet.context.authoritativeWiki.map((entry) => entry.id)).not.toContain('llmwiki-legacy-page');
        expect(packet.context.excludedWiki).toContainEqual({ id: 'llmwiki-legacy-page', reason: 'invalid' });
    });

    it('is reported by the audit, which is where it gets repaired', async () => {
        const root = await workspace();

        const { auditWiki } = await import('../../src/wiki/lifecycle.js');
        const audit = await auditWiki(root);

        expect(audit.invalidRecords.map((entry) => entry.path)).toEqual([
            join(root, '.kata/wiki/llmwiki-legacy-page.json'),
        ]);
    });

    it('is still refused where it is the record being used', async () => {
        const root = await workspace();

        // Revalidation cannot silently bless a record it cannot read: the point of tolerance is that the record is not
        // *used*, not that drift in it is ignored.
        const { revalidateWikiRecord } = await import('../../src/wiki/drift.js');
        await expect(revalidateWikiRecord(root, 'llmwiki-legacy-page')).rejects.toThrow(/does not match its schema/);
    });
});
