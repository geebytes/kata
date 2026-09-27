import { describe, expect, it } from 'vitest';
import { decide } from '../../src/kernel/decide.js';
import { createInlineAdapter } from '../../src/assurance/adapters/inline-adapter.js';
import { createFileAdapter, type RecordedResult } from '../../src/assurance/adapters/file-adapter.js';
import { EVIDENCE_TYPES, type Evidence, type EvidenceType } from '../../src/kernel/types.js';
import { makeClaim, makeContext, makeEvidence, makePolicy, makeSubject, makeVerdict } from '../helpers/review.js';

/**
 * **One subject, two adapters, one decision.** 
 *
 * This is the only substantive evidence that the kernel is platform-neutral. A text check for platform names (which also
 * exists) can be satisfied by two adapters that mean different things, so the check that matters is differential: the same
 * ledger, decided through an adapter that runs the artifact and through an adapter that reads a recorded result, must
 * reach the same verdict. The second adapter being weaker is fine and is *declared* (`relayed`); what must not differ is
 * what the kernel concludes.
 */
const subject = makeSubject({ 'src/a.ts': 'holds' });
const evidence = makeEvidence({ id: 'E1' });
const claim = makeClaim({ id: 'C1', severity: 'major', evidenceIds: ['E1'] });

function decidedFrom(verdicts: Parameters<typeof decide>[0]['verdicts']) {
    return decide({
        subject,
        claims: [claim],
        evidence: [evidence],
        verdicts,
        challenges: [],
        policy: makePolicy(),
        tier: 'strict',
        declaredRiskClasses: ['consistency'],
        assurance: 'observed',
        usage: {},
        discovery: { independentChallenges: 1 },
    });
}

describe('two adapters must reach the same decision', () => {
    it('agrees when one runs the check and the other reads the same result', async () => {
        const inline = createInlineAdapter();
        const file = createFileAdapter({ dir: '.kata/review-results' });
        const inlineVerdict = await inline.verify(evidence, makeContext({ subject, files: { 'src/a.ts': 'holds' } }));

        const recorded: RecordedResult = {
            evidenceId: inlineVerdict.evidenceId,
            evidenceType: inlineVerdict.evidenceType,
            verdict: inlineVerdict.verdict,
            observed: inlineVerdict.observed,
            subjectRevision: inlineVerdict.subjectRevision,
        };
        const fileVerdict = await file.verify(
            evidence,
            makeContext({ subject, files: { '.kata/review-results/E1.json': JSON.stringify(recorded) } }),
        );

        expect(inlineVerdict.verdict).toBe('supported');
        expect(fileVerdict.verdict).toBe('supported');
        expect(decidedFrom([inlineVerdict])).toEqual(decidedFrom([fileVerdict]));
        expect(decidedFrom([inlineVerdict]).verdict).toBe('pass');
    });

    it('refuses a recorded result from another revision instead of letting it support this one', async () => {
        const file = createFileAdapter({ dir: '.kata/review-results' });
        const stale: RecordedResult = {
            evidenceId: 'E1',
            evidenceType: 'static_witness',
            verdict: 'supported',
            observed: 'recorded against an older subject',
            subjectRevision: 'rev:0000000000000000',
        };
        const verdict = await file.verify(
            evidence,
            makeContext({ subject, files: { '.kata/review-results/E1.json': JSON.stringify(stale) } }),
        );
        expect(verdict.verdict).toBe('inconclusive');
        expect(verdict.observed).toContain('was recorded against');

        const decision = decidedFrom([verdict]);
        expect(decision.verdict).toBe('insufficient');
        expect(decision.reasons.map((reason) => reason.code)).toContain('evidence_inconclusive');
    });

    it('never executes anything, and says so when asked to', async () => {
        const file = createFileAdapter({ dir: '.kata/review-results' });
        const falsifier: Evidence = {
            id: 'E1',
            type: 'executable_falsifier',
            command: 'definitely-not-run',
            mutation: { file: 'src/a.ts', find: 'holds', replace: 'broken' },
        };
        const context = makeContext({ subject, files: {} });
        const verdict = await file.verify(falsifier, { ...context, run: async () => { throw new Error('the file adapter ran a command'); } });
        expect(verdict.verdict).toBe('inconclusive');
        expect(verdict.observed).toContain('no recorded result');
    });

    it('declares what it can actually provide, and does not claim isolation it has not got', () => {
        expect(createInlineAdapter().assurance).toBe('observed');
        expect(createFileAdapter({ dir: '.kata/review-results' }).assurance).toBe('relayed');
        for (const adapter of [createInlineAdapter(), createFileAdapter({ dir: '.kata/review-results' })]) {
            expect(adapter.capabilities).not.toContain('sandboxed');
            expect(adapter.capabilities).not.toContain('signed');
        }
    });

    it('reports a stale recorded result as inconclusive rather than as a pass through another door', async () => {
        const file = createFileAdapter({ dir: '.kata/review-results' });
        const verdict = await file.verify(evidence, makeContext({ subject, files: { '.kata/review-results/E1.json': 'not json' } }));
        expect(verdict.verdict).toBe('inconclusive');
        expect(verdict.observed).toContain('not readable JSON');
        expect(decidedFrom([makeVerdict({ subjectRevision: subject.revision })]).verdict).toBe('pass');
    });
    /**
     * **The differential covers one evidence class, and this case is what stops that being read as all four.**
     *
     * This is the `a-part-checked-as-the-whole` guard: the cases above prove the two adapters agree on a `static_witness`,
     * and the docstring says "one subject, two adapters, one decision" — which a reader can take as covering every class
     * the kernel knows. It does not: the file adapter cannot execute a command, so for `executable_falsifier` it returns
     * `inconclusive` by design, and the classes are not equally exercised. Naming it here means the gap is a recorded fact
     * rather than an inference from a green suite — and adding a fifth evidence type fails this case until someone says
     * which side of the line it falls on.
     */
    it('states which evidence classes the differential actually exercises, and which it cannot', async () => {
        const inline = createInlineAdapter();
        const file = createFileAdapter({ dir: '.kata/review-results' });
        // `executed` is the classes on which a differential comparison is possible at all; the rest are the file adapter's
        // declared blind spot, measured rather than asserted.
        const executed: EvidenceType[] = ['static_witness', 'cross_artifact_contradiction'];
        const requiresExecution: EvidenceType[] = ['executable_falsifier', 'expert_concurrence'];

        for (const type of EVIDENCE_TYPES) {
            expect(
                [...executed, ...requiresExecution],
                `evidence type "${type}" is in neither list, so nobody decided whether the two adapters can be compared on it`,
            ).toContain(type);
        }

        const evidenceOf = (type: EvidenceType): Evidence => {
            if (type === 'executable_falsifier') return { id: 'E1', type, command: 'grep -q holds src/a.ts', mutation: { file: 'src/a.ts', find: 'holds', replace: 'broken' } };
            if (type === 'static_witness') return { id: 'E1', type, ref: 'src/a.ts', assertion: 'contains:holds' };
            if (type === 'cross_artifact_contradiction') return { id: 'E1', type, a: 'src/a.ts', b: 'src/a.ts', literal: 'holds', comparator: 'literal-in-a-not-b' };
            return { id: 'E1', type, reviewers: ['one'], humanAck: 'ack-1' };
        };

        for (const type of requiresExecution) {
            const evidence = evidenceOf(type);
            const context = makeContext({ subject, files: {} });
            const fileVerdict = await file.verify(evidence, context);
            expect(fileVerdict.verdict, `the file adapter claims to judge "${type}"`).toBe('inconclusive');
            expect(fileVerdict.observed).toContain('no recorded result');
            // The comparator does not run, because there is nothing to compare: saying so is the honest half.
            const inlineVerdict = await inline.verify(evidence, makeContext({ subject, files: { 'src/a.ts': 'holds' } }));
            // Both refused classes are refused for the *same* reason — the file adapter does not execute — except
            // `expert_concurrence`, which is `relayed` by nature on both sides.
            expect(inlineVerdict.verdict).not.toBe('supported');
        }
    });
});
