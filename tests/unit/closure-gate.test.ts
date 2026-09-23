import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { hasReddening, readFalsifierReddenings, recordFalsifierReddening } from '../../src/quality/falsifier-reddenings.js';

const cleanup: string[] = [];
afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-reddening-'));
    cleanup.push(root);
    await initLayout(root);
    await createTask({ root, id: 'r-task', title: 'r-task', ownedPaths: ['src/x.ts'], acceptance: [{ id: 'AC-1', statement: 'x' }] } as never);
    return root;
}

const reddening = (findingId: string) => ({
    findingId,
    check: 'tests/unit/x.test.ts',
    mutation: 'revert the guard the repair added',
    revisionId: 'revision-one',
    reddenedAt: '2026-09-23T02:00:00.000Z',
});

/**
 * The store behind `closure-gate` AC-1: a finding's falsifier was **shown reddening**. Kept additive in this slice — the
 * criterion that consumes it is the next one, and it is not committed until the fixtures that close finding-shaped
 * obligations supply a reddening (measured: eleven cases across six files).
 */
describe('the falsifier-reddening ledger', () => {
    it('records a reddening and reads it back', async () => {
        const root = await workspace();
        await recordFalsifierReddening(root, 'r-task', reddening('a-finding'));

        const read = await readFalsifierReddenings(root, 'r-task');
        expect(read).toHaveLength(1);
        expect(read[0]?.findingId).toBe('a-finding');
        expect(hasReddening(read, 'a-finding')).toBe(true);
        expect(hasReddening(read, 'another-finding')).toBe(false);
    });

    it('re-recording the same finding replaces rather than duplicates, so one finding has one reddening', async () => {
        const root = await workspace();
        await recordFalsifierReddening(root, 'r-task', reddening('a-finding'));
        await recordFalsifierReddening(root, 'r-task', { ...reddening('a-finding'), check: 'tests/unit/y.test.ts', reddenedAt: '2026-09-23T03:00:00.000Z' });

        const read = await readFalsifierReddenings(root, 'r-task');
        expect(read).toHaveLength(1);
        expect(read[0]?.check).toBe('tests/unit/y.test.ts');
    });

    it('reads an empty ledger for a task that has never recorded one', async () => {
        const root = await workspace();
        expect(await readFalsifierReddenings(root, 'r-task')).toEqual([]);
    });
});
