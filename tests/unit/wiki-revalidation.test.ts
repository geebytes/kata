import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { revalidateStaleRecords, revalidateWikiRecord, verifySources } from '../../src/wiki/drift.js';
import { readWikiRecords, writeWikiRecord } from '../../src/wiki/store.js';

/**
 * `stale` has to be a state, not a sentence.
 *
 * `verifySources` marked a record stale when its sources changed, and nothing could move it back: `register` skips an
 * existing id, `promote` requires `candidate`, `rebuild` clears the store. A page edited once left a record that stayed
 * stale forever — and the closure gate reads records, so it could keep reading one whose sources no longer matched.
 */
describe('revalidating a stale Wiki record', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function seeded(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-wiki-revalidate-'));
        roots.push(root);
        await initLayout(root);
        await mkdir(join(root, 'docs'), { recursive: true });
        await writeFile(join(root, 'docs/rule.md'), '# Rule\n\nFirst version.\n', 'utf8');
        await writeWikiRecord(root, {
            id: 'rule-page', statement: 'A durable rule.', scope: ['docs/rule.md'], kind: 'convention',
            sourceRefs: ['docs/rule.md'],
            sourceHashes: { 'docs/rule.md': (await import('../../src/wiki/record.js')).computeFileHash('# Rule\n\nFirst version.\n') },
            validationTaskId: 'task-1', evidenceIds: ['evidence-1'], status: 'candidate',
            lastVerifiedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        });
        return root;
    }

    it('moves a record whose source changed back to candidate, and records what was refreshed', async () => {
        const root = await seeded();
        await writeFile(join(root, 'docs/rule.md'), '# Rule\n\nSecond version.\n', 'utf8');

        // The drift check marks it stale…
        const drifted = await verifySources(root);
        expect(drifted.stale.map((entry) => entry.id)).toEqual(['rule-page']);
        expect((await readWikiRecords(root))[0]!.status).toBe('stale');

        // …and revalidation is the transition back: hashes refreshed, status candidate so promotion still has to happen.
        const result = await revalidateWikiRecord(root, 'rule-page');

        expect(result).toMatchObject({ id: 'rule-page', status: 'candidate', refreshed: ['docs/rule.md'] });
        await expect(verifySources(root)).resolves.toMatchObject({ stale: [], intact: ['rule-page'] });
    });

    it('revalidates every stale record at once', async () => {
        const root = await seeded();
        await writeFile(join(root, 'docs/rule.md'), '# Rule\n\nThird version.\n', 'utf8');

        const { report, revalidated } = await revalidateStaleRecords(root);

        expect(report.stale).toHaveLength(1);
        expect(revalidated[0]).toMatchObject({ id: 'rule-page', status: 'candidate' });
        await expect(verifySources(root)).resolves.toMatchObject({ stale: [] });
    });

    it('reports a missing source instead of hiding it', async () => {
        const root = await seeded();
        await rm(join(root, 'docs/rule.md'));

        const result = await revalidateWikiRecord(root, 'rule-page');

        // The ref stays on the record: the gap is visible, and the next drift check says so again.
        expect(result.refreshed).toEqual(['docs/rule.md']);
        await expect(verifySources(root)).resolves.toMatchObject({ stale: [{ id: 'rule-page', reason: 'source_missing' }] });
    });
});
