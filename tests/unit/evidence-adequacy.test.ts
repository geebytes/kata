import { describe, expect, it } from 'vitest';
import { evaluateAcceptanceAdequacy } from '../../src/quality/evidence-adequacy.js';
import { judge, type JudgeAcceptanceResult } from '../../src/quality/judge.js';
import type { EvidenceEnvelope } from '../../src/quality/evidence.js';
import type { ReviewFinding } from '../../src/quality/reviewer.js';

/**
 * One shared table for the question both the Judge and the workflow's verify step ask. The two used to answer it with
 * separate ladders that had already diverged at the edges — verify knew about unresolved obligations, the Judge knew
 * about cross-revision evidence — so both the common ladder and those two divergences are pinned here.
 */
describe('evidence adequacy', () => {
    const diffHash = 'a'.repeat(64);

    function evidence(overrides: Partial<EvidenceEnvelope> & { id: string }): EvidenceEnvelope {
        return {
            taskId: 'adequacy-task',
            kind: 'test',
            command: 'npm test',
            exitCode: 0,
            startedAt: '2026-09-17T00:00:00.000Z',
            finishedAt: '2026-09-17T00:00:01.000Z',
            diffHash,
            ...overrides,
        } as EvidenceEnvelope;
    }

    const acceptance = [{ id: 'AC-1', statement: 'The behaviour is evidenced.' }];

    function evaluate(overrides: Partial<Parameters<typeof evaluateAcceptanceAdequacy>[0]> = {}) {
        return evaluateAcceptanceAdequacy({
            acceptance,
            evidence: [evidence({ id: 'evidence-1' })],
            findings: [],
            currentDiffHash: diffHash,
            ...overrides,
        });
    }

    function scopesOf(result: { acceptance: JudgeAcceptanceResult[] }): Array<string | undefined> {
        return result.acceptance.map((item) => item.repairScope);
    }

    it('passes an acceptance covered by a fresh, passing test', () => {
        const result = evaluate();

        expect(result.acceptance).toEqual([{ id: 'AC-1', result: 'PASS', evidenceIds: ['evidence-1'] }]);
        expect(result.evidenceIds).toEqual(['evidence-1']);
    });

    it('fails on failing evidence first, whatever else is wrong', () => {
        const finding: ReviewFinding = { id: 'F-1', taskId: 'adequacy-task', severity: 'blocking', message: 'Blocked.' };
        const result = evaluate({
            evidence: [evidence({ id: 'evidence-1', exitCode: 1 })],
            findings: [finding],
        });

        expect(scopesOf(result)).toEqual(['failing_evidence']);
    });

    it('distinguishes stale evidence from missing evidence', () => {
        // A test ran, but not against the current diff: the acceptance is stale rather than uncovered.
        expect(scopesOf(evaluate({ evidence: [evidence({ id: 'evidence-1', diffHash: 'b'.repeat(64) })] })))
            .toEqual(['stale_evidence']);
        // No test evidence at all: the acceptance has no coverage.
        expect(scopesOf(evaluate({ evidence: [evidence({ id: 'evidence-1', kind: 'lint' })] })))
            .toEqual(['missing_test_evidence']);
    });

    it('requires row-specific evidence for an entrypoint or integration acceptance', () => {
        const matrix = {
            version: 1 as const,
            rows: [{
                acceptanceId: 'AC-1',
                verificationLevel: 'entrypoint' as const,
                implementationPaths: ['src/core/state.ts'],
                testPaths: ['tests/unit/state.test.ts'],
                evidence: [{ kind: 'entrypoint' as const, command: 'kata-cli status --change adequacy-task' }],
            }],
        };

        expect(scopesOf(evaluate({ matrix }))).toEqual(['insufficient_evidence_level']);
        const withEntrypoint = evaluate({
            matrix,
            evidence: [
                evidence({ id: 'evidence-1' }),
                evidence({ id: 'evidence-2', kind: 'entrypoint', command: 'kata-cli status --change adequacy-task' }),
            ],
        });
        expect(scopesOf(withEntrypoint)).toEqual([undefined]);
    });

    it('fails on a blocking finding, and on a major finding in strict mode only', () => {
        const major: ReviewFinding = { id: 'F-1', taskId: 'adequacy-task', severity: 'major', message: 'Major.' };

        expect(scopesOf(evaluate({ findings: [major] }))).toEqual([undefined]);
        expect(scopesOf(evaluate({ findings: [major], reviewMode: 'strict' }))).toEqual(['blocking_review_finding']);
    });

    it('reports an unresolved obligation only when the caller supplies obligations (verify, not Judge)', () => {
        const obligations = [{ id: 'obligation-1', acceptanceId: 'AC-1', message: 'Still open.' }];

        expect(scopesOf(evaluate({ unresolvedObligations: obligations }))).toEqual(['unresolved_repair_obligation']);
        expect(scopesOf(evaluate())).toEqual([undefined]);
    });

    it('refuses mixed-revision evidence only when the caller asks it to (Judge, not verify)', () => {
        const mixed = [
            evidence({ id: 'evidence-1', revisionId: 'revision-1' }),
            evidence({ id: 'evidence-2', revisionId: 'revision-2' }),
        ];

        const judgeSide = evaluate({ evidence: mixed, rejectCrossRevision: true });
        expect(judgeSide.crossRevision).toBe(true);
        expect(scopesOf(judgeSide)).toEqual(['cross_revision_evidence']);
        expect(judgeSide.evidenceIds).toEqual([]);

        // Without the refusal the mixed set is observed but still evaluated.
        const verifySide = evaluate({ evidence: mixed });
        expect(verifySide.crossRevision).toBe(true);
        expect(scopesOf(verifySide)).toEqual([undefined]);
    });

    it('gives the Judge the same verdicts as the shared evaluator for the common cases', async () => {
        const cases: Array<Partial<Parameters<typeof evaluateAcceptanceAdequacy>[0]>> = [
            {},
            { evidence: [evidence({ id: 'evidence-1', exitCode: 1 })] },
            { evidence: [evidence({ id: 'evidence-1', diffHash: 'b'.repeat(64) })] },
            { evidence: [evidence({ id: 'evidence-1', kind: 'lint' })] },
            { findings: [{ id: 'F-1', taskId: 'adequacy-task', severity: 'blocking', message: 'Blocked.' }] },
        ];

        for (const testCase of cases) {
            const shared = evaluate({ ...testCase, rejectCrossRevision: true });
            const judged = await judge({
                taskId: 'adequacy-task',
                acceptance: acceptance as Array<{ id: string; statement: string }>,
                evidence: testCase.evidence ?? [evidence({ id: 'evidence-1' })],
                findings: testCase.findings ?? [],
                currentDiffHash: diffHash,
            });

            expect(judged.acceptance).toEqual(shared.acceptance);
            expect(judged.result).toBe(shared.acceptance.every((item) => item.result === 'PASS') ? 'PASS' : 'FAIL');
        }
    });
});
