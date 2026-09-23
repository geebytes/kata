import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { hasReddening, readFalsifierReddenings, recordFalsifierReddening } from '../../src/quality/falsifier-reddenings.js';
import { obligationIsAnswered } from '../../src/quality/repair-obligations.js';

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

/**
 * AC-1's criterion, and its RED was the change's whole reason: before this, **two of these three failed with
 * `expected true to be false`** — an obligation with no reddening closed on passing evidence alone, so a repair that added an
 * assertion which cannot fail closed exactly like one that added an assertion which can.
 */
describe('a finding-shaped obligation needs a reddening, not only evidence', () => {
    const obligation = { id: 'obl-1', findingId: 'a-finding', acceptanceId: 'AC-1', raisedAt: '2026-09-23T01:00:00.000Z' } as never;
    const evidence = [{ id: 'e1', exitCode: 0, kind: 'test', command: 'npx vitest run tests/unit/x.test.ts' }] as never;

    it('stays open when no falsifier has been shown reddening', () => {
        const answered = obligationIsAnswered({ obligation, resolvedAcceptanceIds: ['AC-1'], evidence, reddenings: [] } as never);
        expect(answered.answered).toBe(false);
    });

    it('closes when the finding has a recorded reddening', () => {
        const answered = obligationIsAnswered({
            obligation,
            resolvedAcceptanceIds: ['AC-1'],
            evidence,
            reddenings: [{ findingId: 'a-finding', check: 'tests/unit/x.test.ts', mutation: 'revert the guard', revisionId: 'revision-one', reddenedAt: '2026-09-23T02:00:00.000Z' }],
        } as never);
        expect(answered.answered).toBe(true);
    });

    it('does not close on a reddening recorded for a different finding', () => {
        const answered = obligationIsAnswered({
            obligation,
            resolvedAcceptanceIds: ['AC-1'],
            evidence,
            reddenings: [{ findingId: 'another-finding', check: 'tests/unit/y.test.ts', mutation: 'revert something else', revisionId: 'revision-one', reddenedAt: '2026-09-23T02:00:00.000Z' }],
        } as never);
        expect(answered.answered).toBe(false);
    });

    it('leaves an obligation with no finding behind it alone', () => {
        // An obligation raised by a failed criterion has no falsifier to show — the rule fires on one thing only.
        const fromCriterion = { id: 'obl-2', acceptanceId: 'AC-1', raisedAt: '2026-09-23T01:00:00.000Z' } as never;
        const answered = obligationIsAnswered({ obligation: fromCriterion, resolvedAcceptanceIds: ['AC-1'], evidence, reddenings: [] } as never);
        expect(answered.answered).toBe(true);
    });
});
