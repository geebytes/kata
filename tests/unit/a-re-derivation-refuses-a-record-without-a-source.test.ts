import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { revalidateStaleRecords, revalidateWikiRecord, verifySources } from '../../src/wiki/drift.js';
import { readFileSync } from 'node:fs';
import { readWikiRecords, readWikiRecordsWithIssues } from '../../src/wiki/store.js';
import { computeFileHash } from '../../src/wiki/record.js';

/**
 * **A record whose source is gone is not re-derivable, and saying otherwise is the fail-open direction.**
 *
 * `revalidateWikiRecord` kept the old hashes when a source could not be read, pushed the ref into `refreshed` (a field that
 * means "this hash was recomputed"), and returned the record to `candidate`. The closure gate accepts `candidate`, so a
 * record describing a page that no longer exists became acceptable again — while its `sourceHashes` still silently held the
 * hash of a file that is gone. Measured on this repository: the ref stays visible to the drift walk, which is right; the
 * status must not.
 *
 * The refusal names the path, which is what the previous behaviour claimed to do ("reports a missing source instead of
 * hiding it") and did only half of: the gap was visible to the drift walk and invisible to every reader of the status.
 */
const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function seeded(page: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-wiki-nosource-'));
    roots.push(root);
    await initLayout(root);
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs/rule.md'), page, 'utf8');
    await writeFile(
        join(root, '.kata/wiki/rule-page.json'),
        `${JSON.stringify({
            id: 'rule-page',
            statement: 'A durable rule.',
            scope: ['docs/rule.md'],
            kind: 'convention',
            sourceRefs: ['docs/rule.md'],
            sourceHashes: { 'docs/rule.md': computeFileHash(page) },
            validationTaskId: 'task-1',
            evidenceIds: ['evidence-1'],
            status: 'stale',
            // Pinned, not `new Date()`: the bulk-route case asserts that the walk moved exactly `updatedAt`, and a fixture
            // stamped in the same millisecond as the walk's own write would make that assertion depend on elapsed wall clock.
            lastVerifiedAt: '2026-01-01T00:00:00.000Z',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
        }, null, 2)}\n`,
        'utf8',
    );
    return root;
}

describe('a record whose source is gone is refused by name, and left alone', () => {
    it('refuses to re-derive a record whose source file does not exist, naming the path', async () => {
        const root = await seeded('# Rule\n\nFirst version.\n');
        await rm(join(root, 'docs/rule.md'));

        await expect(revalidateWikiRecord(root, 'rule-page')).rejects.toThrow(/docs\/rule\.md/);
    });

    it('leaves the record exactly as it was when it refuses', async () => {
        const root = await seeded('# Rule\n\nFirst version.\n');
        const before = await readWikiRecords(root);
        await rm(join(root, 'docs/rule.md'));

        await expect(revalidateWikiRecord(root, 'rule-page')).rejects.toThrow();
        const after = await readWikiRecords(root);

        expect(after).toEqual(before);
        expect(after[0]?.status).toBe('stale');
        expect(after[0]?.sourceHashes['docs/rule.md']).toBe(computeFileHash('# Rule\n\nFirst version.\n'));
    });

    it('refuses a record whose recorded hashes do not describe its declared sources', async () => {
        // **Two sets answered "what are this record's sources".** The drift walk iterates `sourceHashes`; the refusal and the
        // recomputation iterate `sourceRefs`. A file named only by the hash map was therefore refused by neither — and the
        // recomputation, which writes the map it built, would have dropped that entry silently. A record whose halves
        // disagree is corrupt, so it is refused by name and left as it was rather than repaired into agreement (measured by
        // an independent round).
        const root = await seeded('# Rule\n\nFirst version.\n');
        const path = join(root, '.kata/wiki/rule-page.json');
        const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        const hashes = record.sourceHashes as Record<string, string>;
        // Both directions of the mismatch, and the digest is a real one: the first version of this case used `deadbeef`,
        // which the record schema rejects for being eight hex characters, so it was green on the schema branch while reading
        // as though it tested the correspondence (measured — the mutation that disables the check left it passing).
        record.sourceHashes = { ...hashes, 'docs/ghost.md': computeFileHash('ghost') };
        await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
        const before = readFileSync(path, 'utf8');

        await expect(revalidateWikiRecord(root, 'rule-page')).rejects.toThrow(/ghost\.md/);
        expect(readFileSync(path, 'utf8')).toBe(before);

        // The other direction: a declared source with no recorded hash. The schema cannot require a property per array item,
        // so this shape is legal — and without the check the recomputation fills it in, repairing a corrupt record silently.
        record.sourceHashes = hashes;
        record.sourceRefs = ['docs/rule.md', 'docs/second.md'];
        await writeFile(join(root, 'docs/second.md'), '# Second\n\nBody.\n', 'utf8');
        await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

        await expect(revalidateWikiRecord(root, 'rule-page')).rejects.toThrow(/second\.md/);
    });

    it('reports what the bulk route moved, so its byte-identity claim is not wider than its behaviour', async () => {
        // **The claim has an edge, and the edge is a field.** On the single route a refusal changes nothing; on the bulk
        // route the drift walk has already rewritten the record it is about to refuse — through `updateWikiRecord`, which
        // stamps `updatedAt`. The honest assertion is the measured one: the status and the sources are untouched, and
        // `updatedAt` is the only field the walk moved. Written down rather than left out, because "the record is untouched"
        // is exactly the sentence an independent round would (and did) test.
        const root = await seeded('# Rule\n\nFirst version.\n');
        const path = join(root, '.kata/wiki/rule-page.json');
        const before = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        await rm(join(root, 'docs/rule.md'));

        const { refused } = await revalidateStaleRecords(root);
        const after = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

        expect(refused.map((entry) => entry.id)).toEqual(['rule-page']);
        expect(after.status).toBe(before.status);
        expect(after.sourceHashes).toEqual(before.sourceHashes);
        expect(after.statement).toBe(before.statement);
        expect(after.updatedAt).not.toBe(before.updatedAt);
        const moved = Object.keys(after).filter((key) => JSON.stringify(after[key]) !== JSON.stringify(before[key]));
        expect(moved).toEqual(['updatedAt']);
    });

    it('reports the refused record beside the ones it could re-derive, losing neither', async () => {
        // **The bulk walk had to stop throwing.** With one unrecoverable record the command aborted after the earlier
        // records were refreshed, so the caller lost the rest of the work and the account of what had already happened.
        const root = await seeded('# Rule\n\nFirst version.\n');
        await initLayout(root);
        await mkdir(join(root, 'docs'), { recursive: true });
        await writeFile(join(root, 'docs/other.md'), '# Other\n\nFirst version.\n', 'utf8');
        await writeFile(
            join(root, '.kata/wiki/other-page.json'),
            `${JSON.stringify({
                id: 'other-page', statement: 'Another rule.', scope: ['docs/other.md'], kind: 'convention',
                sourceRefs: ['docs/other.md'],
                sourceHashes: { 'docs/other.md': computeFileHash('# Other\n\nOlder.\n') },
                validationTaskId: 'task-2', evidenceIds: ['evidence-2'], status: 'stale',
                lastVerifiedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            }, null, 2)}\n`,
            'utf8',
        );
        await rm(join(root, 'docs/rule.md'));

        const { revalidated, refused } = await revalidateStaleRecords(root);

        expect(revalidated.map((entry) => entry.id)).toEqual(['other-page']);
        expect(refused.map((entry) => entry.id)).toEqual(['rule-page']);
        expect(refused[0]?.reason).toMatch(/docs\/rule\.md/);
    });

    it('names a repeated source as a repetition, not as a hash that is missing', async () => {
        // **The refusal vocabulary could not express what the check found.** Comparing sorted joins made a record that declares
        // one file twice a mismatch, and the message then said `declared but not hashed: docs/rule.md` — false, that path IS
        // hashed. The schema allows the repetition (`sourceRefs` has no `uniqueItems`), so it is a shape the store can hold,
        // and which declaration the single hash belongs to is not knowable here: named, and refused rather than repaired.
        const root = await seeded('# Rule\n\nFirst version.\n');
        const path = join(root, '.kata/wiki/rule-page.json');
        const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        record.sourceRefs = ['docs/rule.md', 'docs/rule.md'];
        await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
        const before = readFileSync(path, 'utf8');

        await expect(revalidateWikiRecord(root, 'rule-page')).rejects.toThrow(/more than once/);
        expect(readFileSync(path, 'utf8')).toBe(before);
    });

    it('answers about the record it was asked for, not about a file whose name merely ends the same way', async () => {
        // **A suffix test is not an identity test.** The lookup for an unreadable record was `path.endsWith(`${id}.json`)`, so
        // `.kata/wiki/bca.json` was reported as the damage behind the id `a` — a refusal that answers about a different record
        // than the one asked for (measured by an independent round; the line predates this change and sits in the function the
        // change repairs). The comparison is on the filename the store derives with `normalizeId`.
        const root = await seeded('# Rule\n\nFirst version.\n');
        await writeFile(join(root, '.kata/wiki/bca.json'), '{ this is not json\n', 'utf8');

        await expect(revalidateWikiRecord(root, 'a')).rejects.toThrow(/was not found/);
    });

    it('reaches a record whose status is stale even when its sources match again', async () => {
        // **The bulk route was scoped to the drift check's classification, not to the store's status.** `verifySources`
        // classifies by sources alone, so a record left `stale` by an earlier drift whose source was afterwards restored to
        // its recorded content reads as `intact` — and was therefore neither revalidated nor refused: it stayed stale with no
        // road named to the operator (measured by an independent round). The walk now iterates the records whose status is
        // `stale`, which is what its name and its answer are about.
        const root = await seeded('# Rule\n\nFirst version.\n');
        const path = join(root, '.kata/wiki/rule-page.json');
        const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        record.status = 'stale';
        await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

        // The source matches what is recorded, so the drift check calls this record intact.
        const drifted = await verifySources(root);
        expect(drifted.intact).toEqual(['rule-page']);

        const { revalidated, refused } = await revalidateStaleRecords(root);

        expect(refused).toEqual([]);
        expect(revalidated.map((entry) => entry.id)).toEqual(['rule-page']);
    });

    it('looks at a declared source with no recorded hash, rather than calling the record intact', async () => {
        // **The walk and the refusal answered "what are this record's sources" with different sets.** `verifySources`
        // iterated `sourceHashes` while `revalidateWikiRecord` iterates `sourceRefs`, so a path declared with no recorded hash
        // was never examined by the walk — it reported the record intact while the refusal path refused exactly that shape. The
        // walk iterates the union now, and this case is what makes that load-bearing: with the old iteration the record is
        // `intact` and this assertion fails.
        const root = await seeded('# Rule\n\nFirst version.\n');
        const path = join(root, '.kata/wiki/rule-page.json');
        await mkdir(join(root, 'docs'), { recursive: true });
        await writeFile(join(root, 'docs/second.md'), '# Second\n\nBody.\n', 'utf8');
        const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        record.sourceRefs = ['docs/rule.md', 'docs/second.md'];
        await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

        const report = await verifySources(root);

        expect(report.intact).toEqual([]);
        expect(report.stale.map((entry) => entry.id)).toEqual(['rule-page']);
        expect(report.stale[0]?.changedSources).toContain('docs/second.md');
        // **The cause is named as its own.** Borrowing `source_changed` made the walk describe a file that did not move, and
        // sent the operator to `revalidate`, which refuses exactly this record (measured by an independent round).
        expect(report.stale[0]?.reason).toBe('source_unrecorded');
    });

    it('reports an unreadable store as unreadable, not as an empty one', async () => {
        // **The reader mapped "a store I could not read" onto "a store with nothing in it".** Everything except `ENOENT` was
        // swallowed, so a record directory that cannot be read (a file in its place is an `ENOTDIR`, which unlike a permission
        // bit is not defeated by running as root) answered the closure gate's question with "the record is not offered"
        // (measured by an independent round). The reader now reports it through the channel it already has, and the gate asks
        // whether the store it just read was readable.
        const root = await seeded('# Rule\n\nFirst version.\n');
        const wikiDir = join(root, '.kata/wiki');
        await rm(wikiDir, { recursive: true, force: true });
        await writeFile(wikiDir, 'not a directory', 'utf8');

        const { invalid } = await readWikiRecordsWithIssues(root);

        expect(invalid).toHaveLength(1);
        expect(invalid[0]?.message).toMatch(/cannot be read/);
    });

    it('still reports the gap to the drift walk, so the missing source stays visible', async () => {
        const root = await seeded('# Rule\n\nFirst version.\n');
        await rm(join(root, 'docs/rule.md'));

        const report = await verifySources(root);

        expect(report.stale).toEqual([{ id: 'rule-page', reason: 'source_missing', changedSources: ['docs/rule.md'] }]);
        expect(report.missing).toEqual(['docs/rule.md']);
    });
});
