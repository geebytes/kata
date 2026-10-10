import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initLayout, taskDir } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { appendReviewRound, readReviewRoundsState, reviewRoundsPath } from '../../src/quality/repair.js';

/**
 * **A round keeps what it found, not only how many.** Measured on 2026-10-10: this repository holds 102 review rounds and 56
 * findings, because a row kept `blockingIds` and a count while `review.json` is overwritten by the next round. The one
 * reading that would say whether the loop is converging — which class of defect keeps coming back, and whether it came back
 * inside a previous repair — could not be read at all, so every change paid for the same class again.
 */
let root: string;
const changeId = 'a-round-record-carries-its-findings';

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-round-findings-'));
    await initLayout(root);
    await createTask({
        root,
        id: changeId,
        title: 'A round record carries its findings',
        acceptance: [{ id: 'AC-1', statement: 'The row keeps what the round found.' }],
        ownedPaths: ['src/a.ts'],
    });
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('a round record carries its findings', () => {
    it('keeps the class and the origin of every finding the round produced', async () => {
        await appendReviewRound(root, changeId, {
            at: '2026-10-10T00:00:00.000Z',
            revisionId: 'revision-1',
            manifestHash: 'a'.repeat(64),
            blockingIds: ['R-1'],
            blockingCount: 1,
            findings: [
                { id: 'R-1', severity: 'blocking', class: 'one-fact-derived-twice', origin: 'repair' },
                { id: 'R-2', severity: 'minor', class: 'instrument-unsound', origin: 'original' },
            ],
        });

        const read = await readReviewRoundsState(root, changeId);
        expect(read.kind).toBe('readable');
        expect(read.rounds).toHaveLength(1);
        expect(read.rounds[0].findings).toEqual([
            { id: 'R-1', severity: 'blocking', class: 'one-fact-derived-twice', origin: 'repair' },
            { id: 'R-2', severity: 'minor', class: 'instrument-unsound', origin: 'original' },
        ]);
        // The row is append-only: a second round adds a line rather than replacing the first, because the history is the point.
        await appendReviewRound(root, changeId, {
            at: '2026-10-10T01:00:00.000Z',
            blockingIds: [],
            blockingCount: 0,
            noFindings: 'the approval cleared a review that recorded no findings',
        });
        const after = await readReviewRoundsState(root, changeId);
        expect(after.rounds).toHaveLength(2);
        expect(after.rounds[1].noFindings).toBe('the approval cleared a review that recorded no findings');
        expect(await readFile(reviewRoundsPath(root, changeId), 'utf8')).toMatch(/R-1/);
    }, 60_000);

    it('refuses a round that carries neither findings nor a reason for having none', async () => {
        // **The shape this refuses is the defect.** An id list and a count is indistinguishable from a round whose findings
        // nobody kept; "the round found nothing" and "nobody wrote down what it found" must not look the same in the history.
        await expect(
            appendReviewRound(root, changeId, {
                at: '2026-10-10T00:00:00.000Z',
                revisionId: 'revision-1',
                blockingIds: ['R-1'],
                blockingCount: 1,
            }),
        ).rejects.toThrow(/no findings and no reason/);
        // And nothing was written: a refused round leaves no half-record behind.
        await expect(readReviewRoundsState(root, changeId)).resolves.toMatchObject({ kind: 'absent' });
    }, 60_000);

    it('refuses findings the reader would not keep, and never reports them as a round with none', async () => {
        // **The guard and the reader ask the same predicate** (R2-F6). The guard measured `length` while the reader kept only
        // entries carrying an `id` and a `severity` — so a non-array, or entries the reader drops, passed the guard and read
        // back as `unavailable`: the history would say a round happened and not what it found.
        await expect(
            appendReviewRound(root, changeId, { at: '2026-10-10T00:00:00.000Z', blockingIds: [], blockingCount: 0, findings: 'not-an-array' as never }),
        ).rejects.toThrow(/no findings and no reason/);
        await expect(
            appendReviewRound(root, changeId, { at: '2026-10-10T00:00:00.000Z', blockingIds: [], blockingCount: 0, findings: [{ note: 'no id, no severity' } as never] }),
        ).rejects.toThrow(/no findings and no reason/);
        // A hand-written row the reader cannot use is reported as damaged rather than as a round that found nothing.
        await mkdir(dirname(reviewRoundsPath(root, changeId)), { recursive: true });
        await writeFile(reviewRoundsPath(root, changeId), `${JSON.stringify({ at: '2026-10-10T00:00:00.000Z', blockingIds: [], blockingCount: 0, findings: [{ note: 'x' }] })}\n`);
        const read = await readReviewRoundsState(root, changeId);
        expect(read.kind).toBe('readable');
        if (read.kind !== 'readable') return;
        expect(read.rounds[0]?.findings).toBeUndefined();
    });

    it('refuses an empty findings list with no reason', async () => {
        // **Empty is not a reason** (R1-F4). `findings: []` with no `noFindings` reads back as `unavailable`, which is the
        // identical "nobody kept what it found" ambiguity this rule refuses — reached through the empty-array door. A row with
        // genuinely nothing to report says so with a reason.
        await expect(
            appendReviewRound(root, changeId, { at: '2026-10-10T00:00:00.000Z', blockingIds: [], blockingCount: 0, findings: [] }),
        ).rejects.toThrow(/no findings and no reason/);
        await expect(readReviewRoundsState(root, changeId)).resolves.toMatchObject({ kind: 'absent' });
        // And the reason-carrying form is what a round with nothing to report writes.
        await appendReviewRound(root, changeId, { at: '2026-10-10T00:00:00.000Z', blockingIds: [], blockingCount: 0, noFindings: 'the approval cleared a review with no findings' });
        await expect(readReviewRoundsState(root, changeId)).resolves.toMatchObject({ kind: 'readable' });
    });

    it('still reads a row written before the field existed', async () => {
        // Legacy rows stay readable — the same rule the finding's own class field follows. A history that cannot be read is a
        // worse outcome than an incomplete one.
        const { mkdir, writeFile } = await import('node:fs/promises');
        await mkdir(taskDir(root, changeId), { recursive: true });
        await writeFile(
            join(taskDir(root, changeId), 'review-rounds.jsonl'),
            `${JSON.stringify({ at: '2026-10-01T00:00:00.000Z', revisionId: 'revision-0', blockingIds: ['R-9'], blockingCount: 1 })}\n`,
            'utf8',
        );
        const read = await readReviewRoundsState(root, changeId);
        expect(read.kind).toBe('readable');
        expect(read.rounds[0]).toMatchObject({ blockingIds: ['R-9'], blockingCount: 1 });
        expect(read.rounds[0].findings).toBeUndefined();
    }, 60_000);
});
