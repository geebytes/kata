import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { revalidateWikiRecord } from '../../src/wiki/drift.js';
import { computeFileHash } from '../../src/wiki/record.js';

/**
 * **Re-derivation must not move a record the wrong way, and a refusal must change nothing.**
 *
 * Two states where "refresh the hashes" is the wrong answer:
 *
 * - a `verified` record. Its status is a governance claim reached through promotion (a passing validation task and matching
 *   source hashes). `revalidateWikiRecord` set `status: 'candidate'` unconditionally, so calling it on a verified record
 *   **silently demoted** the strongest state the store has — a strength change with no decision behind it.
 * - an id that does not exist. The command reported as if it had re-derived something.
 *
 * The byte-comparison half is the part that matters: a refusal that has already written the record has not refused.
 */
const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function seeded(status: 'candidate' | 'verified' | 'stale'): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-wiki-refuse-'));
    roots.push(root);
    await initLayout(root);
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs/rule.md'), '# Rule\n\nSecond version.\n', 'utf8');
    await writeFile(
        join(root, '.kata/wiki/rule-page.json'),
        `${JSON.stringify({
            id: 'rule-page',
            statement: 'A durable rule.',
            scope: ['docs/rule.md'],
            kind: 'convention',
            sourceRefs: ['docs/rule.md'],
            // A hash of the *previous* page, so a record left alone is distinguishable from one that was refreshed.
            sourceHashes: { 'docs/rule.md': computeFileHash('# Rule\n\nFirst version.\n') },
            validationTaskId: 'task-1',
            evidenceIds: ['evidence-1'],
            status,
            ...(status === 'verified'
                ? { approvalEvent: { approvedBy: 'a-reviewer', role: 'reviewer', approvedAt: new Date().toISOString() } }
                : {}),
            lastVerifiedAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        }, null, 2)}\n`,
        'utf8',
    );
    return root;
}

describe('re-deriving refuses what it must not touch', () => {
    it('refuses a verified record by name, and does not demote it', async () => {
        const root = await seeded('verified');
        const path = join(root, '.kata/wiki/rule-page.json');
        const before = await readFile(path, 'utf8');

        await expect(revalidateWikiRecord(root, 'rule-page')).rejects.toThrow(/verified/);
        expect(await readFile(path, 'utf8')).toBe(before);
    });

    it('refuses an id that does not exist by name', async () => {
        const root = await seeded('stale');

        await expect(revalidateWikiRecord(root, 'no-such-record')).rejects.toThrow(/no-such-record/);
    });

    it('still moves a stale record, so the refusal is about the two states and not about refusing everything', async () => {
        // The control: a repair that refused every call would pass the two cases above.
        const root = await seeded('stale');

        const result = await revalidateWikiRecord(root, 'rule-page');

        expect(result).toMatchObject({ id: 'rule-page', status: 'candidate', refreshed: ['docs/rule.md'] });
    });
});
