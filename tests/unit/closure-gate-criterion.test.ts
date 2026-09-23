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
            reddenings: [{ findingId: 'a-finding', check: 'tests/unit/x.test.ts', mutation: 'revert the guard', revisionId: 'revision-one', reddenedAt: '2026-09-23T02:00:00.000Z', observed: { before: 0, mutated: 1, after: 0 } }],
        } as never);
        expect(answered.answered).toBe(true);
    });

    it('does not close on a reddening recorded for a different finding', () => {
        const answered = obligationIsAnswered({
            obligation,
            resolvedAcceptanceIds: ['AC-1'],
            evidence,
            reddenings: [{ findingId: 'another-finding', check: 'tests/unit/y.test.ts', mutation: 'revert something else', revisionId: 'revision-one', reddenedAt: '2026-09-23T02:00:00.000Z', observed: { before: 0, mutated: 1, after: 0 } }],
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

/**
 * AC-5: the criterion's own falsifier enumerates **every** producer of the closure decision rather than asserting one pair.
 *
 * The reason it is written this way is measured: `wcc2-f1` and `kgs3-f3` were both "the fix was applied to one derivation of
 * a concept that has several", and a test asserting one pair would have let each of them survive. So each input the decision
 * reads is asserted load-bearing — drop any one and the verdict must change.
 */

/**
 * AC-4's rule, and the case its first version lacked — `kata-cli falsify` refused that version with `did_not_redden`, because
 * every fixture used the valid shape `{ before: 0, mutated: 1, after: 0 }` and so never exercised the rule. **A falsifier that
 * names a check which was never run does not close the obligation**: a record with no observed runs is exactly that, and it is
 * the difference between "the check ran and reddened" and "someone wrote down that it would".
 */
describe('a reddening with no observed runs does not close an obligation', () => {
    const obligation = { id: 'obl-1', findingId: 'a-finding', acceptanceId: 'AC-1', raisedAt: '2026-09-23T01:00:00.000Z' } as never;
    const evidence = [{ id: 'e1', exitCode: 0, kind: 'test', command: 'npx vitest run tests/unit/x.test.ts' }] as never;
    const base = { findingId: 'a-finding', check: 'tests/unit/x.test.ts', mutation: 'revert', revisionId: 'revision-one', reddenedAt: '2026-09-23T02:00:00.000Z' };

    it('stays open when the reddening records no runs', () => {
        const answered = obligationIsAnswered({
            obligation, resolvedAcceptanceIds: ['AC-1'], evidence,
            reddenings: [{ ...base }],
        } as never);
        expect(answered.answered).toBe(false);
    });

    it('stays open when the recorded runs are not the shape a reddening has', () => {
        // The mutation did not redden, or the restore did not bring it back: either way it is not a reddening.
        const answered = obligationIsAnswered({
            obligation, resolvedAcceptanceIds: ['AC-1'], evidence,
            reddenings: [{ ...base, observed: { before: 0, mutated: 0, after: 0 } }],
        } as never);
        expect(answered.answered).toBe(false);
    });

    it('closes when the runs are the shape a reddening has', () => {
        const answered = obligationIsAnswered({
            obligation, resolvedAcceptanceIds: ['AC-1'], evidence,
            reddenings: [{ ...base, observed: { before: 0, mutated: 1, after: 0 } }],
        } as never);
        expect(answered.answered).toBe(true);
    });
});

/**
 * The revision narrowing, and the case its first version lacked — `kata-cli falsify` refused that version with `did_not_redden`,
 * because every case passed no `revisionId` and so left the narrowing unexercised. A reddening is proof about **one revision's
 * content**: a later re-seal must not inherit it, which is what the field promises and what this asserts.
 */
describe('a reddening for another revision does not close an obligation', () => {
    const obligation = { id: 'obl-1', findingId: 'a-finding', acceptanceId: 'AC-1', raisedAt: '2026-09-23T01:00:00.000Z' } as never;
    const evidence = [{ id: 'e1', exitCode: 0, kind: 'test', command: 'npx vitest run tests/unit/x.test.ts' }] as never;
    const reddening = {
        findingId: 'a-finding', check: 'tests/unit/x.test.ts', mutation: 'revert',
        revisionId: 'revision-one', reddenedAt: '2026-09-23T02:00:00.000Z',
        observed: { before: 0, mutated: 1, after: 0 },
    };

    it('stays open when the reddening was observed on a different revision', () => {
        const answered = obligationIsAnswered({
            obligation, resolvedAcceptanceIds: ['AC-1'], evidence,
            reddenings: [reddening], revisionId: 'revision-two',
        } as never);
        expect(answered.answered).toBe(false);
    });

    it('closes when it was observed on the revision being resolved', () => {
        const answered = obligationIsAnswered({
            obligation, resolvedAcceptanceIds: ['AC-1'], evidence,
            reddenings: [reddening], revisionId: 'revision-one',
        } as never);
        expect(answered.answered).toBe(true);
    });
});
