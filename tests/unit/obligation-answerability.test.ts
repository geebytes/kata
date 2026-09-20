import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { obligationIsAnswered, persistBlockingFindings, readObligations, resolveObligationsForRevision } from '../../src/quality/repair-obligations.js';
import type { EvidenceEnvelope } from '../../src/quality/evidence.js';

/**
 * The seal and the resolver must answer one question the same way.
 *
 * The defect this file guards against is not a wrong answer but **two** answers: `collectSealPreflight` refused a seal
 * while an obligation lacked a `resolvedAt`, and the resolver that sets one ran after the checks — so the seal could
 * refuse an obligation the run was about to answer, which is a deadlock. Both now consult `obligationIsAnswered`, and
 * this asserts they agree: for every shape, the verdict the preflight would read is the outcome the resolver produces.
 *
 * Asserted **jointly** rather than as two expectations, because two expectations can both pass while disagreeing.
 */
describe('the seal and the resolver agree about answerability', () => {
    const roots: string[] = [];
    afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

    function passing(id: string): EvidenceEnvelope {
        return {
            id, taskId: 'x', kind: 'test', command: 'npm test', exitCode: 0,
            startedAt: '2026-09-20T00:00:00.000Z', finishedAt: '2026-09-20T00:00:01.000Z', diffHash: 'a'.repeat(64),
        };
    }

    /** Each case: an obligation shape, the run's evidence, and what both callers must conclude. */
    const cases: Array<{
        label: string;
        obligation: { severity: string; acceptanceId?: string };
        resolvedAcceptanceIds: string[];
        evidence: EvidenceEnvelope[];
        expected: boolean;
    }> = [
        { label: 'unscoped, passing evidence', obligation: { severity: 'major' }, resolvedAcceptanceIds: ['AC-1'], evidence: [passing('e1')], expected: true },
        { label: 'unscoped, no evidence', obligation: { severity: 'major' }, resolvedAcceptanceIds: ['AC-1'], evidence: [], expected: false },
        { label: 'scoped, criterion satisfied', obligation: { severity: 'blocking', acceptanceId: 'AC-1' }, resolvedAcceptanceIds: ['AC-1'], evidence: [passing('e1')], expected: true },
        { label: 'scoped, criterion not satisfied', obligation: { severity: 'blocking', acceptanceId: 'AC-9' }, resolvedAcceptanceIds: ['AC-1'], evidence: [passing('e1')], expected: false },
        // Without a matrix there is nothing to match evidence against, so a satisfied criterion is the whole answer —
        // the pre-existing matrix-less semantics, pinned by the matrix e2e test. The *unscoped* row above is the case that
        // needs evidence, because there is no criterion standing in for it.
        { label: 'scoped and satisfied, no evidence — a matrix-less task has nothing to match against', obligation: { severity: 'blocking', acceptanceId: 'AC-1' }, resolvedAcceptanceIds: ['AC-1'], evidence: [], expected: true },
    ];

    for (const testCase of cases) {
        it(`agrees on: ${testCase.label}`, async () => {
            const root = await mkdtemp(join(tmpdir(), 'kata-answerable-'));
            roots.push(root);
            await initLayout(root);
            const taskId = 'answerable-task';
            await createTask({ root, id: taskId, title: 'Answerability', acceptance: [{ id: 'AC-1', statement: 'x' }] });
            await persistBlockingFindings(root, taskId, [{ id: 'finding-1', severity: testCase.obligation.severity, ...(testCase.obligation.acceptanceId ? { acceptanceId: testCase.obligation.acceptanceId } : {}), message: 'm' }]);
            const [obligation] = await readObligations(root, taskId);

            // What the preflight reads — a verdict computed without touching anything.
            const dryVerdict = obligationIsAnswered({ obligation: obligation!, resolvedAcceptanceIds: testCase.resolvedAcceptanceIds, evidence: testCase.evidence }).answered;

            // What the resolver does — the same inputs, and it may commit the answer.
            await resolveObligationsForRevision(root, taskId, 'revision-1', testCase.resolvedAcceptanceIds, testCase.evidence.map((item) => item.id), undefined, testCase.evidence);
            const [after] = await readObligations(root, taskId);
            const actuallyResolved = Boolean(after!.resolvedAt);

            expect({ dryVerdict, actuallyResolved, expected: testCase.expected }).toEqual({
                dryVerdict: testCase.expected,
                actuallyResolved: testCase.expected,
                expected: testCase.expected,
            });
        });
    }
});
