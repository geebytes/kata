import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readReviewRoundsState } from '../../src/quality/repair.js';

/**
 * **A record that parses is not necessarily a record.**
 *
 * `readReviewRoundsState` treated *parseable* as *a round*: `42`, `{}` and `[]` all became rounds, so a file of numbers
 * read as a history of unmeasured rounds and the loop's escalation counted rounds nobody had recorded. Shape and parse are
 * different facts, and only one of them is about the record.
 *
 */
const roots: string[] = [];
let root: string;
const taskId = 'rounds-shape';

afterEach(async () => {
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kata-rounds-'));
    roots.push(root);
    await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
});

async function writeRounds(...lines: string[]): Promise<void> {
    await writeFile(join(root, '.kata', 'tasks', taskId, 'review-rounds.jsonl'), `${lines.join('\n')}\n`);
}

describe('a review-round record whose JSON parses but whose shape is not a round', () => {
    it('is malformed rather than counted as a round', async () => {
        await writeRounds('42');
        const read = await readReviewRoundsState(root, taskId);
        expect(read.kind).toBe('unreadable');
    });

    it('treats an empty object and an array the same way, because neither is a round', async () => {
        for (const line of ['{}', '[]', 'null', '"a string"']) {
            await writeRounds(line);
            expect(await readReviewRoundsState(root, taskId), line).toMatchObject({ kind: 'unreadable' });
        }
    });

    it('accepts a well formed round, so the check is about shape and not about JSONL', async () => {
        await writeRounds('{"at":"2026-09-29T00:00:00.000Z","blockingIds":["R-1"],"blockingCount":1}');
        const read = await readReviewRoundsState(root, taskId);
        expect(read).toMatchObject({ kind: 'readable' });
        expect(read.rounds[0]?.blockingIds).toEqual(['R-1']);
        expect(read.rounds[0]?.blockingCount).toBe(1);
    });

    it('keeps the parseable prefix and reports the damage, rather than reading the file as shorter', async () => {
        await writeRounds(
            '{"at":"2026-09-29T00:00:00.000Z","blockingIds":["R-1"],"blockingCount":2}',
            '{}',
            '{"at":"2026-09-29T00:01:00.000Z","blockingIds":[],"blockingCount":0}',
        );
        const read = await readReviewRoundsState(root, taskId);
        if (read.kind !== 'unreadable') throw new Error(`expected unreadable, got ${read.kind}`);
        expect(read.rounds).toHaveLength(3);
        expect(read.detail).toContain('malformed');
    });
});
