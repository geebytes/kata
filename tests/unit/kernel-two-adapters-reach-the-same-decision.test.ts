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
        touchedRiskClasses: ['consistency'],
        assurance: 'observed',
        usage: {},
        discovery: { independentChallenges: 1, verifiedChallenges: 1 },
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
     * **The differential on every evidence class, with a recorded result present.**
     *
     * The previous version of this case was wrong in both directions, and the way it was wrong is worth keeping written
     * down. It declared `executable_falsifier` and `expert_concurrence` a permanent *blind spot* of the file adapter
     * ("it cannot execute a command, so it returns `inconclusive` by design") and asserted that on fixtures with no
     * recorded result — so it proved a fact about the *inputs* while describing it as a fact about the *classes*.
     *
     * Two things follow, and both are the opposite of what it claimed. The file adapter returns whatever verdict a
     * recorded result carries, for every evidence type, so the differential is possible on **all four**; and
     * `expert_concurrence` never needed execution at all — its verifier reads `humanAck`. A declared limitation that does
     * not exist is worse than a missing test: it excuses the untested path, which is exactly what happened here.
     *
     * So the comparison runs on each class in turn, and a fifth evidence type fails this case until someone decides
     * whether the two adapters can be compared on it.
     */
    it('reaches the same decision on every evidence class when a result has been recorded', async () => {
        const inline = createInlineAdapter();
        const file = createFileAdapter({ dir: '.kata/review-results' });

        /** One well-formed item per type, and the file contents the inline verifier needs to support it. */
        const cases: Record<EvidenceType, { evidence: Evidence; files: Record<string, string>; exitRule?: (command: string, files: Record<string, string>) => number }> = {
            static_witness: {
                evidence: { id: 'E1', type: 'static_witness', ref: 'src/a.ts', assertion: 'contains:holds' },
                files: { 'src/a.ts': 'holds' },
            },
            // A falsifier whose three steps succeed: the command passes, the mutation makes it fail, the restore passes again.
            // The exit rule is the three-step protocol made observable — the check greps for the literal the mutation removes,
            // so it can only exit 0 while the literal is there. Without this the run always exits 0 and the verifier correctly
            // reports `refuted` ("the check did not redden"), which is a true statement about a fixture that cannot redden.
            executable_falsifier: {
                evidence: { id: 'E1', type: 'executable_falsifier', command: 'grep -q holds src/a.ts', mutation: { file: 'src/a.ts', find: 'holds', replace: 'broken' } },
                files: { 'src/a.ts': 'holds' },
                exitRule: (_command, files) => (files['src/a.ts'] === 'holds' ? 0 : 1),
            },
            // The two sides of the contradiction: the literal is in `a` and not in `b`.
            cross_artifact_contradiction: {
                evidence: { id: 'E1', type: 'cross_artifact_contradiction', a: 'src/a.ts', b: 'src/b.ts', literal: 'holds', comparator: 'literal-in-a-not-b' },
                files: { 'src/a.ts': 'holds', 'src/b.ts': 'stable' },
            },
            // Concurrence needs no command at all: it needs the acknowledgement receipt to exist and two reviewers to be named.
            expert_concurrence: {
                evidence: { id: 'E1', type: 'expert_concurrence', reviewers: ['one', 'two'], humanAck: 'ack-1' },
                files: { 'ack-1': 'the reviewers agreed' },
            },
        };

        expect(Object.keys(cases).sort(), 'every evidence type must be in this table, or the differential is partial').toEqual([...EVIDENCE_TYPES].sort());

        for (const type of EVIDENCE_TYPES) {
            const { evidence: item, files, exitRule } = cases[type];
            const inlineVerdict = await inline.verify(item, makeContext({ subject, files, ...(exitRule ? { exitRule } : {}) }));
            expect(inlineVerdict.verdict, `${type} should be supported by the inline adapter`).toBe('supported');

            // The relayed route carries the same reading, and the kernel must conclude the same thing from it.
            const recorded: RecordedResult = {
                evidenceId: inlineVerdict.evidenceId,
                evidenceType: inlineVerdict.evidenceType,
                verdict: inlineVerdict.verdict,
                observed: inlineVerdict.observed,
                subjectRevision: inlineVerdict.subjectRevision,
            };
            const fileVerdict = await file.verify(item, makeContext({ subject, files: { '.kata/review-results/E1.json': JSON.stringify(recorded) } }));
            expect(fileVerdict.verdict, `${type} must survive the relayed route`).toBe('supported');
            expect(decidedFrom([fileVerdict]), `${type} must decide the same through either adapter`).toEqual(decidedFrom([inlineVerdict]));
        }
    });

    it('says what the file adapter cannot do, which is about inputs and not about evidence classes', async () => {
        // The honest statement of the limitation: the file adapter cannot *produce* a verdict, for any class, without a
        // recorded result. It is not blind to command-backed evidence — it is blind until someone runs the round.
        const file = createFileAdapter({ dir: '.kata/review-results' });
        for (const type of EVIDENCE_TYPES) {
            const context = makeContext({ subject, files: {} });
            const item = type === 'executable_falsifier'
                ? ({ id: 'E1', type, command: 'definitely-not-run', mutation: { file: 'src/a.ts', find: 'holds', replace: 'broken' } } as Evidence)
                : type === 'static_witness'
                    ? ({ id: 'E1', type, ref: 'src/a.ts', assertion: 'contains:holds' } as Evidence)
                    : type === 'cross_artifact_contradiction'
                        ? ({ id: 'E1', type, a: 'src/a.ts', b: 'src/b.ts', literal: 'holds', comparator: 'literal-in-a-not-b' } as Evidence)
                        : ({ id: 'E1', type, reviewers: ['one', 'two'], humanAck: 'ack-1' } as Evidence);
            const verdict = await file.verify(item, {
                ...context,
                // Loud if it ever tries: the relayed route must not execute anything, for any class.
                run: async () => { throw new Error('the file adapter ran a command'); },
            });
            expect(verdict.verdict, `${type} with no recorded result`).toBe('inconclusive');
            expect(verdict.observed).toContain('no recorded result');
        }
    });
});
