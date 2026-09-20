import { describe, expect, it } from 'vitest';
import { evaluateAcceptanceAdequacy } from '../../src/quality/evidence-adequacy.js';
import type { EvidenceEnvelope } from '../../src/quality/evidence.js';
import type { AcceptanceMatrix } from '../../src/core/task.js';

/**
 * L2-02: passing evidence must be evidence *for this criterion*.
 *
 * The old evaluator answered every criterion from one global set of passing tests, so a single unrelated test could
 * satisfy a whole task — and the only way to be confident was to re-run everything.
 */
describe('AC-scoped evidence', () => {
    const envelope = (overrides: Partial<EvidenceEnvelope>): EvidenceEnvelope => ({
        id: 'evidence-a',
        taskId: 'ac-task',
        kind: 'test',
        command: 'npx vitest run tests/a.test.ts',
        exitCode: 0,
        passed: true,
        startedAt: '2026-09-20T00:00:00.000Z',
        finishedAt: '2026-09-20T00:00:01.000Z',
        diffHash: 'a'.repeat(64),
        ...overrides,
    });

    const matrix: AcceptanceMatrix = {
        version: 1,
        rows: [
            { acceptanceId: 'AC-1', implementationPaths: ['src/a.ts'], testPaths: ['tests/a.test.ts'], verificationLevel: 'integration', evidence: [{ id: 'check-a', kind: 'test', command: 'npx vitest run tests/a.test.ts', testSelector: 'tests/a.test.ts' }] },
            { acceptanceId: 'AC-2', implementationPaths: ['src/b.ts'], testPaths: ['tests/b.test.ts'], verificationLevel: 'integration', evidence: [{ id: 'check-b', kind: 'test', command: 'npx vitest run tests/b.test.ts', testSelector: 'tests/b.test.ts' }] },
        ],
    };

    it('passes only the criterion whose own check produced the evidence', () => {
        const result = evaluateAcceptanceAdequacy({
            acceptance: [{ id: 'AC-1' }, { id: 'AC-2' }],
            evidence: [envelope({ checkId: 'check-a', coveredAcceptanceIds: ['AC-1'] })],
            findings: [],
            currentDiffHash: 'a'.repeat(64),
            matrix,
        });

        expect(result.acceptance.find((entry) => entry.id === 'AC-1')).toMatchObject({ result: 'PASS' });
        expect(result.acceptance.find((entry) => entry.id === 'AC-2')).toMatchObject({ result: 'FAIL', repairScope: 'insufficient_evidence_level' });
    });

    it('fails a criterion with no matrix row instead of falling back to any passing test', () => {
        const result = evaluateAcceptanceAdequacy({
            acceptance: [{ id: 'AC-3' }],
            evidence: [envelope({ checkId: 'check-a', coveredAcceptanceIds: ['AC-1'] })],
            findings: [],
            currentDiffHash: 'a'.repeat(64),
            matrix,
        });

        expect(result.acceptance[0]).toMatchObject({ result: 'FAIL', repairScope: 'no_acceptance_matrix_row' });
    });

    it('re-reads an old evidence set when no matrix is given, rather than invalidating it', () => {
        const result = evaluateAcceptanceAdequacy({
            acceptance: [{ id: 'AC-1' }],
            evidence: [envelope({ checkId: 'check-a' })],
            findings: [],
            currentDiffHash: 'a'.repeat(64),
        });

        expect(result.acceptance[0]).toMatchObject({ result: 'PASS' });
    });
});
