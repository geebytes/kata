import { describe, expect, it } from 'vitest';
import { evidenceMatchesRow } from '../../src/quality/acceptance-matrix.js';
import type { AcceptanceMatrixRow } from '../../src/core/task.js';

/**
 * Eligibility used to rest on substrings: a declaration matched evidence when the recorded command *contained* the
 * declared one, with hardcoded regexes for `vitest run` and `tsc`, and the check's kind was guessed from its name.
 * A rename, a wrapper script or a differently-worded equivalent changed the verdict without changing what ran.
 *
 * The declaration and the executed check now share an identity, and the fallback remains only for declarations or
 * artefacts that predate ids.
 */
describe('evidence eligibility', () => {
    function row(evidence: AcceptanceMatrixRow['evidence']): AcceptanceMatrixRow {
        return {
            acceptanceId: 'AC-1',
            implementationPaths: ['src/foo.ts'],
            testPaths: ['tests/foo.test.ts'],
            evidence,
            verificationLevel: 'unit',
        };
    }

    it('matches by declared id even when the command text says something else', () => {
        const declared = row([{ id: 'check-a', kind: 'test', command: 'make test' }]);

        // The same check, run through a wrapper the declaration never described: identity carries the verdict.
        expect(evidenceMatchesRow(declared, './scripts/run-suite.sh --unit', 'test', 'check-a')).toBe(true);
        // A different check that happens to mention the same text is not the declared one.
        expect(evidenceMatchesRow(declared, 'make test', 'test', 'check-b')).toBe(false);
    });

    it('still requires the declared kind and verification level', () => {
        const declared = row([{ id: 'check-a', kind: 'test', command: 'make test' }]);
        expect(evidenceMatchesRow(declared, './run.sh', 'lint', 'check-a')).toBe(false);

        const entrypoint = row([{ id: 'check-b', kind: 'entrypoint', command: './smoke.sh' }]);
        expect(evidenceMatchesRow(entrypoint, './smoke.sh', 'test', 'check-b')).toBe(false);
        expect(evidenceMatchesRow(entrypoint, 'anything at all', 'entrypoint', 'check-b')).toBe(true);
    });

    it('falls back to the textual comparison only when the caller has no check id', () => {
        const declared = row([{ kind: 'test', command: 'make test' }]);

        // With no `checkId` there is nothing structural to match on, so the legacy comparison is the only answer available.
        expect(evidenceMatchesRow(declared, 'make test', 'test')).toBe(true);
        expect(evidenceMatchesRow(declared, 'make test --verbose', 'test')).toBe(true);
        expect(evidenceMatchesRow(declared, 'make lint', 'test')).toBe(false);

        // **With a `checkId` it is not.** The fallback used to run here too, so a declaration whose command text was a
        // substring of the envelope's command was credited with proving a row it had nothing to do with — text
        // containment standing in for identity. A caller that knows which check this is gets a structural answer or none.
        expect(evidenceMatchesRow(declared, 'make test --verbose', 'test', 'some-other-check')).toBe(false);
        expect(evidenceMatchesRow(declared, 'make test', 'test', 'some-other-check')).toBe(false);
    });

    it('falls back for evidence recorded before ids existed', () => {
        const declared = row([{ id: 'check-a', kind: 'test', command: 'make test' }]);

        // No checkId on the envelope: the declaration's id cannot match, so legacy evidence is still compared textually
        // rather than rejected outright.
        expect(evidenceMatchesRow(declared, 'make test', 'test')).toBe(true);
    });
});
