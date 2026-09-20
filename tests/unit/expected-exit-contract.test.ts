import { describe, expect, it } from 'vitest';
import { isPassing, checkInputFingerprint, type EvidenceEnvelope } from '../../src/quality/evidence.js';
import { evaluateClaims } from '../../src/quality/claims.js';
import type { AcceptanceCriterion } from '../../src/core/task.js';

/**
 * L2-01: the collector, the claim evaluator and the seal must answer "did this pass?" the same way.
 *
 * The contradiction this removes was measured, not imagined: a claim declaring `expectExitCode: 1` satisfied its sentence
 * in `evaluateClaims` while the seal's `exitCode === 0` predicate reported the same evidence as a failure, so a correct
 * negative assertion could not survive a seal.
 */
describe('the expected-exit contract', () => {
    const acceptance: AcceptanceCriterion[] = [
        {
            id: 'AC-1',
            statement: 'The guard refuses an out-of-scope write.',
            claims: [
                {
                    id: 'refuses',
                    statement: 'A write outside the owned paths is refused.',
                    check: { command: 'node', args: ['guard.mjs'], expect: { exitCode: 1 } },
                },
            ],
        },
    ];

    const envelope = (overrides: Partial<EvidenceEnvelope>): EvidenceEnvelope => ({
        id: 'evidence-claim:AC-1:refuses',
        taskId: 'claim-task',
        checkId: 'claim:AC-1:refuses',
        kind: 'claim',
        command: 'node guard.mjs',
        exitCode: 1,
        expectExitCode: 1,
        passed: true,
        startedAt: '2026-09-20T00:00:00.000Z',
        finishedAt: '2026-09-20T00:00:01.000Z',
        diffHash: 'a'.repeat(64),
        ...overrides,
    });

    it('treats the declared exit code as the outcome, not zero', () => {
        const evidence = [envelope({})];

        expect(isPassing(evidence[0]!)).toBe(true);
        expect(evaluateClaims(acceptance, evidence).failures).toEqual([]);
    });

    it('fails the claim when the check exited zero instead', () => {
        const evidence = [envelope({ exitCode: 0, passed: false })];

        expect(isPassing(evidence[0]!)).toBe(false);
        expect(evaluateClaims(acceptance, evidence).failures).toHaveLength(1);
        expect(evaluateClaims(acceptance, evidence).failures[0]).toMatchObject({ actualExitCode: 0, missing: false });
    });

    it('reads an envelope written before the field existed without re-classifying it', () => {
        const legacy = envelope({ exitCode: 1 });
        delete legacy.passed;

        // The claim still holds: the fallback derives the outcome from the exit code the envelope does carry.
        expect(evaluateClaims(acceptance, [legacy]).failures).toEqual([]);
    });

    it('fingerprints the inputs that decide what runs, and only those', () => {
        const base = { kind: 'test' as const, command: 'node', args: ['run'] };

        expect(checkInputFingerprint(base)).toBe(checkInputFingerprint({ ...base }));
        expect(checkInputFingerprint(base)).not.toBe(checkInputFingerprint({ ...base, testSelector: 'a.test.ts' }));
        expect(checkInputFingerprint(base)).not.toBe(checkInputFingerprint({ ...base, env: { CI: '1' } }));
        // A reuse marker is not part of the input: the fingerprint must not change because something was reused.
        expect(checkInputFingerprint({ ...base, importResult: { exitCode: 0 } })).toBe(checkInputFingerprint(base));
        // Environment values are secrets far more often than predictors, so only the key set participates.
        expect(checkInputFingerprint({ ...base, env: { CI: '1' } })).toBe(checkInputFingerprint({ ...base, env: { CI: '2' } }));
    });
});
