import { describe, expect, it } from 'vitest';
import { EVIDENCE_TYPES, type Evidence } from '../../src/kernel/types.js';
import { admissibleFor, evidenceShapeProblems, MIN_STRENGTH_BY_SEVERITY } from '../../src/kernel/evidence.js';
import { VERIFIERS, verifyAll } from '../../src/producers/verifiers.js';
import { makeContext, makeSubject } from '../helpers/review.js';

/**
 * **Every check must be able to fail — and this is asserted per check, not per type.**
 *
 * Measured on this line: eleven checks that could never fail were caught by mutation, and none of them by reading the
 * code. Requiring a mutation per *type* would be weaker than that discipline, so each verifier here is run twice: once in
 * the state where it must support the claim, and once with the defect injected, where it must say something else. A
 * verifier whose two answers are the same answer is not a check.
 */
const subject = makeSubject({ 'src/a.ts': 'holds', 'docs/a.md': 'says X', 'docs/b.md': 'other' });

describe('every evidence type has a verifier, and every verifier can fail', () => {
    it('covers all five types, exactly', () => {
        expect(VERIFIERS.map((verifier) => verifier.type).sort()).toEqual([...EVIDENCE_TYPES].sort());
    });

    it('static witness reddens when the witness is removed', async () => {
        const evidence: Evidence = { id: 'E', type: 'static_witness', ref: 'src/a.ts', assertion: 'contains:holds' };
        const green = await verifyAll([evidence], makeContext({ subject, files: { 'src/a.ts': 'holds' } }));
        const red = await verifyAll([evidence], makeContext({ subject, files: { 'src/a.ts': 'nope' } }));
        const missing = await verifyAll([evidence], makeContext({ subject, files: {} }));
        expect(green[0]?.verdict).toBe('supported');
        expect(red[0]?.verdict).toBe('refuted');
        expect(missing[0]?.verdict).toBe('inconclusive');
    });

    it('refuses a command-backed check that declares no mutation, which is the hole this suite exists for', async () => {
        // **Measured, not argued.** Before the fifth evidence type was removed, an `invariant_proof` whose command was
        // `bash -c "exit 0"` verified as `supported` and carried a major claim to `pass`: a check that can never fail,
        // accepted as evidence. The type is gone, and a falsifier without a mutation is now inadmissible by shape — so the
        // hole cannot reopen by someone forgetting a rule.
        const noMutation = { id: 'E', type: 'executable_falsifier', command: 'check' } as Evidence;
        expect(evidenceShapeProblems(noMutation)).toContain('mutation.file is required: a check that cannot be reddened is not evidence');

        const incomplete = { ...noMutation, mutation: { file: 'src/a.ts', find: 'x', replace: '' } } as unknown as Evidence;
        expect(evidenceShapeProblems(incomplete)).toEqual([]);

        // And a declared mutation is checked by running the three steps, not by believing the declaration.
        const declared = {
            id: 'E',
            type: 'executable_falsifier',
            command: 'check',
            mutation: { file: 'src/a.ts', find: 'holds', replace: 'broken' },
        } as Evidence;
        const green = await verifyAll([declared], makeContext({
            subject,
            files: { 'src/a.ts': 'holds\n' },
            exitRule: (_command, files) => (files['src/a.ts']?.includes('broken') === true ? 1 : 0),
        }));
        expect(green[0]?.verdict).toBe('supported');
        const unsensitive = await verifyAll(
            [{ ...declared, mutation: { file: 'src/a.ts', find: 'nothing-here', replace: 'x' } } as Evidence],
            makeContext({ subject, files: { 'src/a.ts': 'holds\n' } }),
        );
        expect(unsensitive[0]?.verdict).toBe('inconclusive');
        expect(String(unsensitive[0]?.observed)).toContain('mutation site is gone');
    });

    it('cross-artifact reddens when the contradiction resolves', async () => {
        const evidence: Evidence = {
            id: 'E',
            type: 'cross_artifact_contradiction',
            a: 'docs/a.md',
            b: 'docs/b.md',
            literal: 'says X',
            comparator: 'literal-in-a-not-b',
        };
        const green = await verifyAll([evidence], makeContext({ subject, files: { 'docs/a.md': 'says X', 'docs/b.md': 'other' } }));
        const red = await verifyAll([evidence], makeContext({ subject, files: { 'docs/a.md': 'says X', 'docs/b.md': 'also says X' } }));
        expect(green[0]?.verdict).toBe('supported');
        expect(red[0]?.verdict).toBe('refuted');
    });

    it('the falsifier keeps its three steps: a check that does not redden is refused, not trusted', async () => {
        const sensitive: Evidence = {
            id: 'E',
            type: 'executable_falsifier',
            command: 'run-the-check',
            mutation: { file: 'src/a.ts', find: 'holds', replace: 'broken' },
        };
        // The check fails exactly when the defect is present, which is what "sensitive" means.
        const reddening = await verifyAll([sensitive], makeContext({
            subject,
            files: { 'src/a.ts': 'holds' },
            exitRule: (_command, files) => ((files['src/a.ts'] ?? '').includes('holds') ? 0 : 1),
        }));
        expect(reddening[0]?.verdict).toBe('supported');
        expect(reddening[0]?.observed).toContain('"before":0');
        expect(reddening[0]?.observed).toContain('"mutated":1');
        expect(reddening[0]?.observed).toContain('"after":0');

        // The same evidence with a mutation that changes nothing: the check stays green, so it is not sensitive and the
        // verdict says so instead of passing.
        const insensitive: Evidence = { ...sensitive, mutation: { file: 'src/a.ts', find: 'holds', replace: 'holds' } };
        const noReddening = await verifyAll([insensitive], makeContext({
            subject,
            files: { 'src/a.ts': 'holds' },
            exitRule: () => 0,
        }));
        expect(noReddening[0]?.verdict).toBe('refuted');
        expect(noReddening[0]?.observed).toContain('did not redden');

        // A check that is already failing is reporting a defect that is present, not proving sensitivity.
        const alreadyFailing = await verifyAll([sensitive], makeContext({ subject, files: { 'src/a.ts': 'holds' }, exitRule: () => 3 }));
        expect(alreadyFailing[0]?.verdict).toBe('refuted');
        expect(alreadyFailing[0]?.observed).toContain('already failing');

        // And a mutation site that has moved away is reported as inconclusive rather than silently skipped.
        const movedSite = await verifyAll([sensitive], makeContext({ subject, files: { 'src/a.ts': 'rewritten' }, exitRule: () => 0 }));
        expect(movedSite[0]?.verdict).toBe('inconclusive');
        expect(movedSite[0]?.observed).toContain('mutation site is gone');
    });

    it('concurrence needs an auditable receipt', async () => {
        const evidence: Evidence = { id: 'E', type: 'expert_concurrence', reviewers: ['a', 'b'], humanAck: 'acks/1.md' };
        const acked = await verifyAll([evidence], makeContext({ subject, files: { 'acks/1.md': 'acknowledged' } }));
        const unacked = await verifyAll([evidence], makeContext({ subject, files: {} }));
        expect(acked[0]?.verdict).toBe('supported');
        expect(unacked[0]?.verdict).toBe('inconclusive');
    });
});

describe('strength and admissibility', () => {
    it('keeps the weakest type away from the strongest claim', () => {
        expect(admissibleFor('expert_concurrence', 'blocking').ok).toBe(false);
        expect(admissibleFor('expert_concurrence', 'major').ok).toBe(false);
        expect(admissibleFor('expert_concurrence', 'minor').ok).toBe(true);
        expect(admissibleFor('executable_falsifier', 'blocking').ok).toBe(true);
        expect(MIN_STRENGTH_BY_SEVERITY.blocking).toBeGreaterThan(MIN_STRENGTH_BY_SEVERITY.major);
    });

    it('refuses a malformed item before it reaches a verifier, naming the field', () => {
        expect(evidenceShapeProblems({ id: 'E', type: 'static_witness', ref: 'a', assertion: 'whatever' }))
            .toEqual(['assertion must be "contains:<literal>" or "not-contains:<literal>"']);
        expect(evidenceShapeProblems({ id: 'E', type: 'executable_falsifier', command: '', mutation: { file: 'f', find: 'a', replace: 'b' } }))
            .toEqual(['command is required']);
        expect(evidenceShapeProblems({ id: 'E', type: 'expert_concurrence', reviewers: ['only-one'], humanAck: 'a' }))
            .toEqual(['at least two reviewers are required']);
    });
});
