import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { revalidateStaleRecords, revalidateWikiRecord, verifySources } from '../../src/wiki/drift.js';
import { readWikiRecords } from '../../src/wiki/store.js';
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
            lastVerifiedAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
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

    it('still reports the gap to the drift walk, so the missing source stays visible', async () => {
        const root = await seeded('# Rule\n\nFirst version.\n');
        await rm(join(root, 'docs/rule.md'));

        const report = await verifySources(root);

        expect(report.stale).toEqual([{ id: 'rule-page', reason: 'source_missing', changedSources: ['docs/rule.md'] }]);
        expect(report.missing).toEqual(['docs/rule.md']);
    });
});
