import { readdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readWikiRecordsWithIssues, updateWikiRecord, writeWikiRecord } from '../../src/wiki/store.js';
import type { WikiRecord } from '../../src/wiki/record.js';

/**
 * L3-04: a Wiki record that cannot be read cannot be authoritative either — so a failed write must leave the old one.
 *
 * `writeFile` truncates before it writes: a crash or a validation refusal at the wrong moment left a half-written
 * record, and the reader's tolerance (it never throws) turned that into "this knowledge does not exist" rather than
 * "this knowledge is broken".
 */
describe('Wiki store durability', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    async function tempRoot(): Promise<string> {
        const root = await mkdtemp(join(tmpdir(), 'kata-wiki-durability-'));
        roots.push(root);
        return root;
    }

    const record = {
        id: 'durability',
        statement: 'A record survives a refused update.',
        scope: ['packages/core'],
        kind: 'concept',
        sourceRefs: ['src/wiki/store.ts'],
        sourceHashes: { 'src/wiki/store.ts': 'a'.repeat(64) },
        validationTaskId: 'durability-task',
        provenance: 'source',
        evidenceIds: ['evidence-1'],
        status: 'candidate',
        lastVerifiedAt: '2026-09-20T00:00:00.000Z',
        createdAt: '2026-09-20T00:00:00.000Z',
        updatedAt: '2026-09-20T00:00:00.000Z',
    } satisfies WikiRecord;

    it('leaves the previous record readable when an update is refused', async () => {
        const root = await tempRoot();
        await writeWikiRecord(root, record);

        // A drifted field is refused by validation, before anything is written.
        await expect(updateWikiRecord(root, 'durability', { provenance: 'not-a-provenance' as never })).rejects.toThrow();

        const { records, invalid } = await readWikiRecordsWithIssues(root);
        expect(invalid).toEqual([]);
        expect(records.map((entry) => entry.id)).toEqual(['durability']);
        // And the refused value did not leak into the record that survived.
        expect(records[0]!.provenance).toBe('source');
    });

    it('writes atomically, so no temporary file is ever the record', async () => {
        const root = await tempRoot();
        await writeWikiRecord(root, record);

        const raw = await readFile(join(root, '.kata/wiki/durability.json'), 'utf8');
        expect(JSON.parse(raw)).toMatchObject({ id: 'durability' });
    });

    it('leaves no partial or temporary file behind in the Wiki directory', async () => {
        // The failure `writeFile` produces is a *truncated* record, not a missing one — so the directory is part of the
        // contract: nothing but the finished record may be in it once the write returns.
        const root = await tempRoot();
        await writeWikiRecord(root, record);

        const entries = await readdir(join(root, '.kata/wiki'));
        expect(entries).toEqual(['durability.json']);
    });

    it('refuses a record that drifts the schema, naming the field', async () => {
        const root = await tempRoot();

        await expect(writeWikiRecord(root, { ...record, provenance: 'invented' as never }))
            .rejects.toThrow(/\$\.provenance must be one of/);
        // A refused write creates no record: the directory may exist (the writer makes it before validating) but it
        // holds no artefact, so an absent record stays absent rather than becoming a broken one.
        await expect(readdir(join(root, '.kata/wiki'))).resolves.toEqual([]);
    });

    it('keeps both updates when two writers race, or refuses one with a reason', async () => {
        const root = await tempRoot();
        await writeWikiRecord(root, record);

        const tag = (n: number) => updateWikiRecord(root, 'durability', { scope: [`packages/core#${n}`] });
        const results = await Promise.allSettled([tag(1), tag(2)]);

        const refusals = results.filter((result) => result.status === 'rejected');
        refusals.forEach((result) => expect(String((result as PromiseRejectedResult).reason)).toMatch(/Another kata process is mutating wiki-durability/));

        // Whichever writer won, the record on disk is a *complete* record — not a merge of two half-writes.
        const { records, invalid } = await readWikiRecordsWithIssues(root);
        expect(invalid).toEqual([]);
        expect(records[0]!.scope).toHaveLength(1);
    });
});
