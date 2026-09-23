import { readFileSync, readdirSync, statSync } from 'node:fs';
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
    /**
     * The set is **discovered**, not listed. The first version named three files by literal path, and round 3 found a fourth
     * producer outside them (cg3-f3) — which is the same defect as a declaration that names the wrong check, one level up: an
     * enumeration written by hand enumerates what its author remembered.
     */
    const filesUnder = (dir: string): string[] => readdirSync(join(process.cwd(), dir)).flatMap((entry: string) => {
        const relative = join(dir, entry);
        return statSync(join(process.cwd(), relative)).isDirectory() ? filesUnder(relative) : [relative];
    }).filter((path) => path.endsWith('.ts'));

    /**
     * The terms a file **uses**, not the terms it mentions. The first version matched raw text, so a corpus case whose
     * `reproduction` prose says "stamp `resolvedAt` unconditionally" read as a producer of the closure decision — the same
     * defect as counting a comment as a use (wcc2-f4), and the same fix: strip what cannot be code before matching, which can
     * only under-report.
     */
    const codeOf = (text: string) => text
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
        .replace(/`(?:[^`\\]|\\.)*`/g, '``');

    const touching = () => filesUnder('src').filter((path) => {
        const text = codeOf(readFileSync(join(process.cwd(), path), 'utf8'));
        return /obligationIsAnswered|\.resolvedAt\b|resolvedAt\s*=|unresolvedObligations/.test(text);
    });

    it('is decided in one place, and every file that touches it either calls the rule or reads its output', () => {
        const decider = 'src/quality/repair-obligations.ts';
        const touchingFiles = touching();
        // The discovery has to find something, or an empty set would pass this vacuously.
        expect(touchingFiles.length).toBeGreaterThan(3);
        expect(touchingFiles).toContain(decider);

        for (const path of touchingFiles) {
            if (path === decider) continue;
            const text = codeOf(readFileSync(join(process.cwd(), path), 'utf8'));
            const calls = text.includes('obligationIsAnswered(');
            const reads = /\.resolvedAt\b/.test(text) || /resolved\.has\(/.test(text) || text.includes('unresolvedObligations');
            // Either shape is fine — one asks the rule, the other reads what it decided. What is not fine is a file that
            // decides it itself, which is what cg-f1 was.
            expect(calls || reads, `${path} touches the closure decision but neither calls the rule nor reads its output`).toBe(true);
        }
    });

    it('the decider consults the reddening ledger', () => {
        const decider = readFileSync(join(process.cwd(), 'src/quality/repair-obligations.ts'), 'utf8');
        expect(/\bconst\s+answered\s*=/.test(decider)).toBe(true);
        // The disposition, which is a reddening **or** a recorded absence — the second shape exists because a repair to a test
        // or a document has no check that can redden (cg3-f1, cg3-f3).
        expect(decider).toContain('hasFalsifierDisposition(');
    });
});