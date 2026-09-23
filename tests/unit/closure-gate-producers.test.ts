import { readFileSync } from 'node:fs';
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
describe('every producer of the closure decision is load-bearing', () => {
    const finding = { id: 'obl-1', findingId: 'a-finding', acceptanceId: 'AC-1', raisedAt: '2026-09-23T01:00:00.000Z' } as never;
    const evidence = [{ id: 'e1', exitCode: 0, kind: 'test', command: 'npx vitest run tests/unit/x.test.ts' }] as never;
    const reddening = { findingId: 'a-finding', check: 'tests/unit/x.test.ts', mutation: 'revert', revisionId: 'revision-one', reddenedAt: '2026-09-23T02:00:00.000Z', observed: { before: 0, mutated: 1, after: 0 } };
    const matrix = { version: 1, rows: [{ acceptanceId: 'AC-1', implementationPaths: ['src/x.ts'], testPaths: ['tests/unit/x.test.ts'], evidence: [{ id: 'e1', kind: 'test', command: 'npx vitest run tests/unit/x.test.ts', testSelector: 'tests/unit/x.test.ts' }], verificationLevel: 'unit' }] } as never;

    // The baseline: every producer present, and the obligation is answered.
    const baseline = { obligation: finding, resolvedAcceptanceIds: ['AC-1'], evidence, matrix, reddenings: [reddening] };

    it('answers when all four producers agree', () => {
        expect(obligationIsAnswered({ ...baseline } as never).answered).toBe(true);
    });

    it('changes the verdict when the resolved acceptance ids are dropped', () => {
        expect(obligationIsAnswered({ ...baseline, resolvedAcceptanceIds: [] } as never).answered).toBe(false);
    });

    it('changes the verdict when the evidence is dropped', () => {
        expect(obligationIsAnswered({ ...baseline, evidence: [] } as never).answered).toBe(false);
    });

    it('changes the verdict when the matrix is present and the evidence does not match its row', () => {
        // The matrix is load-bearing **in the direction the implementation actually has**: with it, evidence for another
        // command is not evidence for this criterion; without it, any passing envelope is. Asserting both sides is the
        // difference between testing the producer and testing a guess about it — the first version of this case asserted the
        // opposite direction and failed, which is how the real one was found.
        const unrelated = [{ id: 'e9', exitCode: 0, kind: 'test', command: 'npx vitest run tests/unit/other.test.ts' }] as never;
        expect(obligationIsAnswered({ ...baseline, evidence: unrelated } as never).answered).toBe(false);
        expect(obligationIsAnswered({ ...baseline, matrix: undefined, evidence: unrelated } as never).answered).toBe(true);
    });

    it('changes the verdict when the reddening is dropped', () => {
        expect(obligationIsAnswered({ ...baseline, reddenings: [] } as never).answered).toBe(false);
    });
});



/**
 * A validation failure and an absent file were the same answer: `readObligations` wrapped its read in a `catch` that returned
 * `[]`, so a record that failed validation read exactly like a task with no obligations. That hid the cause of two failed
 * attempts at AC-3 — the setup assertion reported `expected [] to have a length of 2` while the obligations had in fact been
 * written — and it is the same shape as an instrument's empty answer standing in for "could not answer".
 */

/**
 * AC-5, as the independent round read it: the criterion is that the change's own falsifier enumerates **every producer of the
 * closure decision**, and enumerating the four *inputs* of `obligationIsAnswered` does not do that — a second derivation of
 * "answered" elsewhere would be invisible to it. So this asserts the producers themselves, from the source: the decision is
 * made in one function, and every consumer of it goes through that function.
 *
 * The finding that produced this case is `cg-f5`, and the blocking one behind it (`cg-f1`) was exactly a second producer: the
 * seal preflight computed the same decision without the ledger this change added.
 */
describe('the closure decision has one producer, and every consumer reaches it', () => {
    const read = (relative: string) => readFileSync(join(process.cwd(), relative), 'utf8');

    it('is computed in obligationIsAnswered, and only there', () => {
        // The one place that **decides** it, and it must consult the reddening ledger.
        const decider = read('src/quality/repair-obligations.ts');
        expect(/\bconst\s+answered\s*=/.test(decider)).toBe(true);
        expect(decider).toContain('hasReddening(');

        // The preflight **calls** it, which is the shape cg-f1 broke by calling it without the ledger.
        const preflight = read('src/workflow/seal-preflight.ts');
        expect(preflight).toContain('obligationIsAnswered(');
        expect(preflight).not.toMatch(/\bconst\s+answered\s*=/);

        // And the batch closure **reads the decision the resolver made** rather than re-deciding — a third shape, and the
        // reason a naive "no other file may mention answered" assertion is wrong. It filters the batch's findings by the
        // resolved obligation ids, so it cannot disagree with the resolver: it has no rule of its own to disagree with.
        const batch = read('src/quality/repair-batch.ts');
        expect(batch).not.toContain('obligationIsAnswered(');
        expect(batch).toMatch(/resolved\.has\(finding\.id\)/);
    });

    it('is reached by every consumer that needs it — the resolver and the preflight', () => {
        // Both were producers in the sense that mattered: the resolver closes obligations and the preflight predicts whether a
        // seal will succeed. The preflight missing the ledger was the deadlock, so both are asserted to import the rule.
        expect(read('src/quality/repair-obligations.ts')).toContain('obligationIsAnswered');
        expect(read('src/workflow/seal-preflight.ts')).toContain('obligationIsAnswered');
        // And the preflight must supply the same inputs the resolver does — the ledger among them.
        expect(read('src/workflow/seal-preflight.ts')).toContain('readFalsifierReddenings');
    });
});

/**
 * The assertion the first version of this file lacked, and `kata-cli falsify` is what found it: the preflight must **pass** the
 * ledger into the decision, not merely import it. Removing the argument from the call is exactly the defect that caused the
 * deadlock (`cg-f1`), and the earlier text assertion stayed green under it — a decorative check, caught by the change's own
 * producer refusing the repair with `did_not_redden`.
 */
describe('the preflight passes the ledger into the decision, not just imports it', () => {
    it('names the ledger inside the call it makes', () => {
        const preflight = readFileSync(join(process.cwd(), 'src/workflow/seal-preflight.ts'), 'utf8');
        const start = preflight.indexOf('obligationIsAnswered({');
        expect(start).toBeGreaterThan(-1);
        const call = preflight.slice(start, preflight.indexOf('});', start));
        expect(call).toContain('reddenings');
    });
});
