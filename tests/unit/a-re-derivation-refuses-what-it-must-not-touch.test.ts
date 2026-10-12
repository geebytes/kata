import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { revalidateStaleRecords, revalidateWikiRecord, verifySources } from '../../src/wiki/drift.js';
import { writeWikiRecord } from '../../src/wiki/store.js';
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

async function seeded(status: 'candidate' | 'verified' | 'stale' | 'rejected'): Promise<string> {
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
            ...(status === 'rejected'
                ? { rejectionEvent: { rejectedBy: 'a-reviewer', role: 'reviewer', rejectedAt: new Date().toISOString(), reason: 'not durable enough' } }
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

    it('refuses a rejected record by name: a refusal is a decision, not a hash to refresh', async () => {
        // **The bottom of the ladder was open.** The guard covered `verified` and nothing else, so a record a person had
        // rejected was re-derived straight back to `candidate` — the status the closure gate accepts (measured by an
        // independent round). "Re-derivation is the transition out of `stale`" is the rule that closes it: the other states
        // are decisions, and a refreshed hash is not one.
        const root = await seeded('rejected');
        const path = join(root, '.kata/wiki/rule-page.json');
        const before = await readFile(path, 'utf8');

        await expect(revalidateWikiRecord(root, 'rule-page')).rejects.toThrow(/rejected/);
        expect(await readFile(path, 'utf8')).toBe(before);
    });

    it('refuses, on the bulk route too, a record whose approval the drift walk just withdrew', async () => {
        // **The guard was on one side of the walk.** `revalidateStaleRecords` calls `verifySources` first, which demotes a
        // `verified` record whose sources moved — so by the time the single-record guard ran, the record read as an ordinary
        // stale one and was re-derived into a `candidate`. The approval came back weaker than it went in, through the bulk
        // door, and the report named it only as `source_changed`. Now the walk says `verified_source_changed` and the bulk
        // route refuses on that name.
        const root = await seeded('verified');
        const path = join(root, '.kata/wiki/rule-page.json');

        const first = await revalidateStaleRecords(root);

        expect(first.report.stale).toHaveLength(1);
        // The cause is the ordinary one; the withdrawal is its own field, so a reader that only cares why the sources stopped
        // matching is unaffected by it.
        expect(first.report.stale[0]?.reason).toBe('source_changed');
        expect(first.report.stale[0]?.approvalWithdrawn).toBe(true);
        expect(first.revalidated).toEqual([]);
        expect(first.refused.map((entry) => entry.id)).toEqual(['rule-page']);
        // The approval is still on the record, and the status is `stale` — never `candidate`: the state the closure gate
        // accepts. Asserted after a SECOND run as well, because "the run that noticed is the only one that refuses" would
        // reopen the hole one call later.
        const second = await revalidateStaleRecords(root);

        expect(second.revalidated).toEqual([]);
        expect(second.refused.map((entry) => entry.id)).toEqual(['rule-page']);
        const after = JSON.parse(await readFile(path, 'utf8')) as { status: string; approvalEvent?: unknown };
        expect(after.status).toBe('stale');
        expect(after.approvalEvent).toBeTruthy();
    });

    it('refuses, in the store, to write a new record over one that carries a decision', async () => {
        // **The route the phrase "every route" missed.** `writeWikiRecord` replaces the file it names (unlike
        // `updateWikiRecord`, which merges), and `ingestLlmWiki` guards the *page* rather than the record — so re-ingesting a
        // source whose page is gone wrote a fresh `candidate` over an approved record, discarding the approval and the prose,
        // and reporting the id as newly governed (measured by an independent round). The guard is at the one choke point every
        // writer passes through, and it is judged inside the lock against the content actually on disk.
        const root = await seeded('verified');
        const path = join(root, '.kata/wiki/rule-page.json');
        const before = await readFile(path, 'utf8');
        const fresh = JSON.parse(before) as Record<string, unknown>;
        delete fresh.approvalEvent;
        fresh.status = 'candidate';
        fresh.statement = 'A stub the writer generated.';

        await expect(writeWikiRecord(root, fresh as never)).rejects.toThrow(/verified/);
        expect(await readFile(path, 'utf8')).toBe(before);

        // …and the rejected end of the ladder, for the same reason.
        const rejected = await seeded('rejected');
        const rejectedPath = join(rejected, '.kata/wiki/rule-page.json');
        const rejectedBefore = await readFile(rejectedPath, 'utf8');
        const rejectedReplacement = JSON.parse(rejectedBefore) as Record<string, unknown>;
        rejectedReplacement.status = 'candidate';
        await expect(writeWikiRecord(rejected, rejectedReplacement as never)).rejects.toThrow(/rejected/);
        expect(await readFile(rejectedPath, 'utf8')).toBe(rejectedBefore);
    });

    it('still replaces a record that carries no decision, so the guard is about decisions', async () => {
        // The control: a store rule that refused every replacement would pass the case above and make re-ingest impossible.
        const root = await seeded('candidate');
        const replacement = { ...(JSON.parse(await readFile(join(root, '.kata/wiki/rule-page.json'), 'utf8')) as Record<string, unknown>) };
        replacement.statement = 'Rewritten.';

        await writeWikiRecord(root, replacement as never);

        const after = JSON.parse(await readFile(join(root, '.kata/wiki/rule-page.json'), 'utf8')) as { statement: string };
        expect(after.statement).toBe('Rewritten.');
    });

    it('still moves a stale record, so the refusal is about the two states and not about refusing everything', async () => {
        // The control: a repair that refused every call would pass the two cases above.
        const root = await seeded('stale');

        const result = await revalidateWikiRecord(root, 'rule-page');

        expect(result).toMatchObject({ id: 'rule-page', status: 'candidate', refreshed: ['docs/rule.md'] });
    });
});
