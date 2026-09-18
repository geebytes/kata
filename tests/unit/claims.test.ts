import { describe, expect, it } from 'vitest';
import { claimCheckId, claimsHash, describeClaimFailure, evaluateClaims, resolveClaimChecks, validateClaims } from '../../src/quality/claims.js';
import type { AcceptanceCriterion } from '../../src/core/task.js';

/**
 * C3: a false sentence in the acceptance text must fail the gate, not wait for the next adversarial round.
 *
 * Measured twice in one day: a claim about the code that was not true passed the seal *and* verify, because prose has no
 * test. What makes this work is that the statement and its command are declared together — editing the sentence is editing
 * the thing the check is attached to.
 */
describe('acceptance claims', () => {
    const acceptance: AcceptanceCriterion[] = [
        {
            id: 'AC-1',
            statement: 'X has no production caller',
            claims: [
                {
                    id: 'no-caller',
                    statement: 'X has no production caller (packages/, excluding its definition)',
                    check: { command: 'grep', args: ['-rn', 'X(', 'packages/'], expect: { exitCode: 1 } },
                },
            ],
        },
    ];

    it('resolves a claim into an ordinary check carrying the claim identity', () => {
        const checks = resolveClaimChecks('/w', acceptance);
        expect(checks).toHaveLength(1);
        expect(checks[0]).toMatchObject({
            id: 'claim:AC-1:no-caller',
            kind: 'claim',
            command: 'grep',
            args: ['-rn', 'X(', 'packages/'],
            expectExitCode: 1,
        });
        expect(claimCheckId('AC-1', 'no-caller')).toBe(checks[0]!.id);
    });

    it('refuses a claim whose check cannot fail, which is what a false sentence hides behind', () => {
        const refusals = validateClaims([
            { id: 'AC-2', statement: 'y', claims: [{ id: 'decorative', statement: 'y holds', check: { command: 'true', expect: undefined as never } }] },
        ]);
        expect(refusals).toHaveLength(1);
        expect(refusals[0]).toMatchObject({ reason: 'no_expected_outcome', claimId: 'decorative' });
        expect(refusals[0]!.detail).toMatch(/cannot fail/);
    });

    it('refuses a claim with no command and a duplicated claim id', () => {
        expect(validateClaims([{ id: 'AC-3', statement: 'z', claims: [{ id: 'empty', statement: 'z', check: { command: '  ', expect: { exitCode: 0 } } }] }])[0])
            .toMatchObject({ reason: 'empty_command' });
        const duplicated = validateClaims([
            {
                id: 'AC-4',
                statement: 'w',
                claims: [
                    { id: 'same', statement: 'w1', check: { command: 'true', expect: { exitCode: 0 } } },
                    { id: 'same', statement: 'w2', check: { command: 'true', expect: { exitCode: 0 } } },
                ],
            },
        ]);
        expect(duplicated[0]).toMatchObject({ reason: 'duplicate_id' });
    });

    it('reports a contradicted claim as a blocking-class failure naming the sentence and the command', () => {
        const { ran, failures } = evaluateClaims(acceptance, [{ checkId: 'claim:AC-1:no-caller', exitCode: 0 }]);
        expect(ran).toHaveLength(1);
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({ actualExitCode: 0, missing: false, expect: { exitCode: 1 } });
        expect(describeClaimFailure(failures[0]!)).toContain('no production caller (packages/');
        expect(describeClaimFailure(failures[0]!)).toContain('expected exit 1, got exit 0');
    });

    it('a claim with no evidence at all is a failure, not a pass', () => {
        const { failures } = evaluateClaims(acceptance, []);
        expect(failures[0]).toMatchObject({ missing: true });
        expect(describeClaimFailure(failures[0]!)).toContain('no evidence was recorded');
    });

    it('a satisfied claim passes, and its identity follows the statement so a rewrite is visible', () => {
        const { failures } = evaluateClaims(acceptance, [{ checkId: 'claim:AC-1:no-caller', exitCode: 1 }]);
        expect(failures).toEqual([]);

        const rewritten: AcceptanceCriterion[] = [
            { ...acceptance[0]!, claims: [{ ...acceptance[0]!.claims![0]!, statement: 'X has no production caller at all' }] },
        ];
        expect(claimsHash(acceptance)).not.toBe(claimsHash(rewritten));
    });
});
