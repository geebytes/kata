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
 * The second disposition, and its limits. A repair whose subject is not code — a test, a document — has no check that can
 * redden, so `kata-cli falsify --none --reason` records the absence instead. It is not a loophole, and these cases are what
 * says so: the absence has to carry a reason, has to be bound to the revision being resolved, and the command refuses to write
 * one without both.
 */
describe('a repair with no falsifier says so, and only with a reason', () => {
    const obligation = { id: 'obl-1', findingId: 'a-finding', acceptanceId: 'AC-1', raisedAt: '2026-09-23T01:00:00.000Z' } as never;
    const evidence = [{ id: 'e1', exitCode: 0, kind: 'test', command: 'npx vitest run tests/unit/x.test.ts' }] as never;
    const absence = {
        findingId: 'a-finding',
        reason: 'The repair is a sentence in a design doc, so prose has no check to redden.',
        revisionId: 'revision-one',
        recordedAt: '2026-09-23T02:00:00.000Z',
    };

    it('closes an obligation when the absence carries a reason', () => {
        expect(obligationIsAnswered({ obligation, resolvedAcceptanceIds: ['AC-1'], evidence, absences: [absence] } as never).answered).toBe(true);
    });

    it('stays open when the reason is empty — the shape exists to be explained', () => {
        expect(obligationIsAnswered({ obligation, resolvedAcceptanceIds: ['AC-1'], evidence, absences: [{ ...absence, reason: '   ' }] } as never).answered).toBe(false);
    });

    it('stays open when the absence is for another revision, like a reddening', () => {
        expect(obligationIsAnswered({ obligation, resolvedAcceptanceIds: ['AC-1'], evidence, absences: [absence], revisionId: 'revision-two' } as never).answered).toBe(false);
    });

    it('refuses to record an absence without a reason', async () => {
        const { runFalsifyCommand } = await import('../../src/cli/ops.js');
        const refused = await runFalsifyCommand(['--change', 'c', '--finding', 'f', '--none']);
        expect(refused.success).toBe(false);
        expect(String(refused.error)).toContain('--reason');
    });
});
