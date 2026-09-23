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
    reddenedAt: '2026-09-23T02:00:00.000Z', observed: { before: 0, mutated: 1, after: 0 },
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
describe('a record that fails validation is not an absent record', () => {
    it('returns empty for a task with no record, and refuses to read an invalid one', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-readoblig-'));
        cleanup.push(root);
        await initLayout(root);
        await createTask({ root, id: 'ro', title: 'ro', ownedPaths: ['src/x.ts'], acceptance: [{ id: 'AC-1', statement: 'x' }] } as never);
        const { readObligations } = await import('../../src/quality/repair-obligations.js');

        // No file: an absence, and an empty list is the honest answer.
        expect(await readObligations(root, 'ro')).toEqual([]);

        // A file that is there and wrong: this must be reported, not read as an absence.
        const { mkdir: mk, writeFile: write } = await import('node:fs/promises');
        await mk(join(root, '.kata/tasks/ro'), { recursive: true });
        await write(join(root, '.kata/tasks/ro/repair-obligations.json'), '{"obligations":"not an array"}\n', 'utf8');
        await expect(readObligations(root, 'ro')).rejects.toThrow();
    });
});




/**
 * The case `cg-f3` names, and its absence is why `kata-cli falsify` refused that repair with `did_not_redden`: the file's
 * validation case was about `readObligations`, so the reddening ledger could go back to an unvalidated read that swallowed its
 * failures and every test still passed. **A record that fails validation is not an absent record**, asserted for this ledger.
 */
describe('the reddening ledger is read through its schema, and a failure is not an absence', () => {
    it('returns empty for a task with no ledger, and refuses to read an invalid one', async () => {
        const root = await workspace();
        expect(await readFalsifierReddenings(root, 'r-task')).toEqual([]);

        const { mkdir: mk, writeFile: write } = await import('node:fs/promises');
        await mk(join(root, '.kata/tasks/r-task'), { recursive: true });
        await write(join(root, '.kata/tasks/r-task/falsifier-reddenings.json'), '{"reddenings":"not an array"}\n', 'utf8');
        await expect(readFalsifierReddenings(root, 'r-task')).rejects.toThrow();
    });
});

/**
 * AC-1's third clause, which round 5 found false as written (`cg5-f2`): the refusal must **name the finding whose falsifier is
 * missing**. It named only acceptance ids — and for the unscoped shape `persistBlockingFindings` creates it named nothing at
 * all, since those obligations carry no `acceptanceId`. So the declaration was true of nothing, and this is what makes it true.
 */
describe('a refusal names the finding whose falsifier is missing', () => {
    it('includes the finding ids the seal cannot answer', async () => {
        const root = await mkdtemp(join(tmpdir(), 'kata-names-'));
        cleanup.push(root);
        await initLayout(root);
        await createTask({ root, id: 'names', title: 'Names', acceptance: [{ id: 'AC-1', statement: 'x' }] } as never);
        const { persistBlockingFindings } = await import('../../src/quality/repair-obligations.js');
        const { collectSealPreflight } = await import('../../src/workflow/seal-preflight.js');
        await persistBlockingFindings(root, 'names', [{ id: 'the-finding-without-a-falsifier', severity: 'major', message: 'm' }] as never);

        const task = await (await import('../../src/core/task.js')).readTask(root, 'names');
        const preflight = await collectSealPreflight({ root, taskId: 'names', task: task as never, ownedPaths: [], options: { plannedEvidence: [] } as never }).catch((error) => ({ error: String(error) }));
        // **The message, not the payload.** The first version asserted the id appears anywhere in the result — and it appears in
        // the obligation list, so the assertion held with the naming removed from the refusal: the seventh decorative check in
        // this change, found by mutating it. The clause is about what the refusal says.
        const blockers = JSON.stringify((preflight as { blockers?: unknown }).blockers ?? preflight);
        expect(blockers).toContain('the-finding-without-a-falsifier');
        expect(blockers).toContain('awaiting a falsifier or a recorded absence');
    });
});
