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

    it('treats a rejected status with no rejection event as a decision too', async () => {
        // **The other limb no fixture reached.** Nothing requires a `rejectionEvent` when `status` is `rejected` (the schema has
        // no conditional), so a record can be rejected with only the status to say so — hand-written, or written by an older
        // tool. A predicate reading only the events would call it undecided and let it be re-derived, or replaced. Both guards
        // are checked on that shape, which is what makes that limb load-bearing.
        const root = await seeded('candidate');
        const path = join(root, '.kata/wiki/rule-page.json');
        const bare = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
        bare.status = 'rejected';
        delete bare.rejectionEvent;
        await writeFile(path, `${JSON.stringify(bare, null, 2)}\n`, 'utf8');
        const before = await readFile(path, 'utf8');

        await expect(revalidateWikiRecord(root, 'rule-page')).rejects.toThrow(/is rejected/);
        await expect(writeWikiRecord(root, bare as never)).rejects.toThrow(/carries a decision/);
        expect(await readFile(path, 'utf8')).toBe(before);
    });

    it('refuses, on the single-record route, a record whose approval was withdrawn earlier', async () => {
        // **The limb no selector reached.** The shared predicate's `approvalEvent !== undefined` clause is what keeps a record
        // whose approval the drift walk withdrew (status `stale`, approval still on the record) from being re-derived into a
        // `candidate` — but every case reaching the bulk route short-circuits on the drift entry's own field, and every fixture
        // paired an approvalEvent with `status: 'verified'`, so deleting that limb was invisible (measured by an independent
        // round). This drives the single-record route on exactly that shape.
        const root = await seeded('verified');
        const path = join(root, '.kata/wiki/rule-page.json');
        const withdrawn = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
        withdrawn.status = 'stale';
        await writeFile(path, `${JSON.stringify(withdrawn, null, 2)}\n`, 'utf8');
        const before = await readFile(path, 'utf8');

        await expect(revalidateWikiRecord(root, 'rule-page')).rejects.toThrow(/approval that was withdrawn/);
        expect(await readFile(path, 'utf8')).toBe(before);
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

    it('drives the road its bulk refusal names, so the sentence is measured and not asserted', async () => {
        // **The sentence is a road, and a road is only true if it is walked.** The first version said "review it, then promote
        // it again if it still holds" — `promote` requires a `candidate` and this refusal only ever fires on a record whose
        // status is `stale`, so the instruction failed in every state that printed it (measured by an independent round). The
        // road it names now is `retire`, which accepts a stale record; this case walks it.
        const root = await seeded('verified');
        const { refused } = await revalidateStaleRecords(root);
        expect(refused.map((entry) => entry.id)).toEqual(['rule-page']);
        // The sentence names `retire` (which this state accepts) and not `promote` (which requires a candidate).
        expect(refused[0]?.reason).toMatch(/wiki retire/);
        expect(refused[0]?.reason).not.toMatch(/promote it again/);

        const { retireWikiRecord } = await import('../../src/wiki/promotion.js');
        const retired = await retireWikiRecord(root, 'rule-page', {
            rejectedBy: 'a-reviewer', role: 'reviewer', rejectedAt: new Date().toISOString(), reason: 'superseded',
        });

        expect(retired.status).toBe('rejected');
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

    it('names only roads that work in the state the store refusal fires in', async () => {
        // **A refusal that prints a closed road is this repository's most expensive recurring defect, and this sentence is
        // measured rather than written from memory.** `rejectCandidate` requires `candidate` and `retireWikiRecord` moves a
        // verified record *to* `rejected` — which this guard also refuses — so "retire it first" would name a road that leaves
        // the operator exactly where they started. Both are driven below: the store still refuses after a retire, which is
        // why the sentence offers only the store-wide road.
        const root = await seeded('verified');
        const path = join(root, '.kata/wiki/rule-page.json');
        const before = await readFile(path, 'utf8');

        const refusal = await writeWikiRecord(root, JSON.parse(before) as never).then(() => '', (error: Error) => error.message);
        expect(refusal).toMatch(/carries a decision/);
        expect(refusal).toMatch(/wiki rebuild/);
        expect(refusal, 'the sentence must not offer a road that leaves the state the same').not.toMatch(/retire it first|reject it first/);

        const { retireWikiRecord } = await import('../../src/wiki/promotion.js');
        await retireWikiRecord(root, 'rule-page', { rejectedBy: 'a-reviewer', role: 'reviewer', rejectedAt: new Date().toISOString(), reason: 'superseded' });
        const afterRetire = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
        afterRetire.statement = 'Written after the decision was closed.';
        await expect(writeWikiRecord(root, afterRetire as never)).rejects.toThrow(/carries a decision/);
    });

    it('refuses to replace a record whose file exists but cannot be read', async () => {
        // **The other unreached limb, and the reason it matters.** The lock reads the record file and hands the mutator the
        // empty string for *any* read error, so an unreadable record used to look exactly like an absent one while the
        // replacement itself only needs write permission on the directory — the content it cannot inspect is precisely what it
        // must not overwrite. A directory in the record's place is an `EISDIR` read error that behaves the same way as an
        // unreadable file, and unlike a permission bit (`chmod 000`) it is not defeated by running as root.
        const root = await seeded('candidate');
        const path = join(root, '.kata/wiki/rule-page.json');
        await rm(path);
        await mkdir(path, { recursive: true });

        await expect(
            writeWikiRecord(root, {
                id: 'rule-page', statement: 'x', scope: ['docs/rule.md'], kind: 'k', sourceRefs: ['docs/rule.md'],
                sourceHashes: { 'docs/rule.md': 'a'.repeat(64) }, validationTaskId: 't', evidenceIds: ['e'], status: 'candidate',
                lastVerifiedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
            } as never),
        ).rejects.toThrow(/cannot be read/);
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
