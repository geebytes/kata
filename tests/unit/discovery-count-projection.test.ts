import { describe, expect, it } from 'vitest';
import type { Challenge, EvidenceVerdict } from '../../src/kernel/types.js';
import type { Probe, ProbeAnswer } from '../../src/kernel/discovery.js';
import { discoveryProjection } from '../../src/store/verdict.js';
import { makeSubject } from '../helpers/review.js';

/**
 * **One projection answers both discovery counts.**
 *
 * Two numbers used to be derived independently: `independentChallenges` from a filter over terminal challenge records plus
 * the raw length of the answer list, and `verifiedChallenges` from a separate walk that de-duplicated commands. The same
 * ledger could therefore report two different counts of the same thing — measured on a real change, where duplicate
 * questions inflated the candidate side to six while the verified side read three — and a stale answer could raise one
 * without the other.
 *
 * Both numbers are now views of one map keyed by the question, so an entry that cannot count cannot count on either side.
 * Identity is the question (one falsifier, one command), never the record that carries it.
 */
const subject = makeSubject({ 'src/a.ts': 'holds', 'src/b.ts': 'other' });
const revision = subject.revision;
const other = 'rev:another-subject';

function probeOf(overrides: Partial<Probe> = {}): Probe {
    return {
        id: 'P1-C1',
        claimId: 'C1',
        kind: 'file-exists',
        path: 'src/a.ts',
        command: 'test -f src/a.ts',
        askedAt: '2026-10-06T00:00:00.000Z',
        subjectRevision: revision,
        ...overrides,
    };
}

function answerOf(overrides: Partial<ProbeAnswer> = {}): ProbeAnswer {
    return {
        probeId: 'P1-C1',
        command: 'test -f src/a.ts',
        observed: 'exit 0',
        answeredAt: '2026-10-06T00:00:00.000Z',
        subjectRevision: revision,
        path: 'src/a.ts',
        expected: 'exists',
        ...overrides,
    };
}

function challengeOf(overrides: Partial<Challenge> = {}): Challenge {
    return {
        id: 'X1',
        claimId: 'C1',
        command: 'grep -q holds src/a.ts',
        failsOn: 'rev:whatever',
        state: 'withdrawn',
        at: '2026-10-06T00:00:00.000Z',
        falsifierEvidenceId: 'E1',
        resolution: {
            at: '2026-10-06T00:01:00.000Z',
            observed: '{"before":0,"mutated":1,"after":0}',
            falsifierEvidenceId: 'E1',
            subjectRevision: revision,
            verdict: 'supported',
        },
        ...overrides,
    };
}

function recordedVerdict(overrides: Partial<EvidenceVerdict> = {}): EvidenceVerdict {
    return {
        evidenceId: 'E1',
        evidenceType: 'executable_falsifier',
        verdict: 'supported',
        observed: '{"before":0,"mutated":1,"after":0}',
        at: '2026-10-06T00:01:00.000Z',
        verifier: 'kata',
        subjectRevision: revision,
        ...overrides,
    };
}

function project(
    input: {
        challenges?: Challenge[];
        probes?: Probe[];
        answers?: ProbeAnswer[];
        declaredFalsifiers?: ReadonlySet<string>;
        recordedVerdicts?: EvidenceVerdict[];
    } = {},
): { independentChallenges: number; verifiedChallenges: number } {
    return discoveryProjection({
        challenges: input.challenges ?? [],
        currentRevision: revision,
        // **The reading the ledger recorded, which the resolution has to agree with.** These cases are about a binding whose
        // run really happened, so the fixture holds one; the case that checks a hand-written resolution passes `[]`.
        recordedVerdicts: input.recordedVerdicts ?? [recordedVerdict()],
        // **The declaration is an input, and these cases are about a falsifier that is declared.** The projection credits
        // a binding only when the ledger declares the falsifier it names, so the fixture has to say which ones it
        // declares — the default is "the one these cases name", and the case that checks an undeclared id passes its own
        // set. An absent set credits nothing, which is asserted separately.
        declaredFalsifiers: input.declaredFalsifiers ?? new Set(['E1']),
    });
}

describe('the discovery projection', () => {
    it('counts a bound falsifier run as one verified reading on both sides', () => {
        expect(project({ challenges: [challengeOf()] })).toEqual({ independentChallenges: 1, verifiedChallenges: 1 });
    });

    it('does not count a falsifier whose run was refuted, but still counts the attempt', () => {
        // The distinction the decision needs: an attempt that decided nothing supports `discovery_unverified` and names the
        // step to take, which is a different refusal from `discovery_floor`.
        const refuted = challengeOf({
            state: 'open',
            resolution: { at: 'x', observed: 'the check did not redden', falsifierEvidenceId: 'E1', subjectRevision: revision, verdict: 'refuted' },
        });
        expect(project({ challenges: [refuted] })).toEqual({ independentChallenges: 1, verifiedChallenges: 0 });
    });

    it('does not verify a run measured against another revision, while still counting the attempt', () => {
        // **An attempt survives a stale measurement; a reading does not.** The challenge is declared for this change, so
        // "record one" would be the wrong remedy — re-running the one on file is. That is `discovery_unverified`, not
        // `discovery_floor`, and the two counts differ exactly here.
        const stale = challengeOf({
            resolution: { at: 'x', observed: '{"before":0,"mutated":1,"after":0}', falsifierEvidenceId: 'E1', subjectRevision: other, verdict: 'supported' },
        });
        expect(project({ challenges: [stale] })).toEqual({ independentChallenges: 1, verifiedChallenges: 0 });
    });

    it('does not verify a resolution that names a different falsifier than the challenge does', () => {
        // The two records must agree about what was reproduced: a resolution that drifted to another falsifier describes a
        // different measurement, and copying it onto this challenge would attribute it to the wrong defect.
        const drifted = challengeOf({
            resolution: { at: 'x', observed: 'observed', falsifierEvidenceId: 'E2', subjectRevision: revision, verdict: 'supported' },
        });
        expect(project({ challenges: [drifted] })).toEqual({ independentChallenges: 1, verifiedChallenges: 0 });
    });

    it('does not count a challenge with no declared falsifier at all', () => {
        // The legacy free form: readable, reportable, and not evidence about this revision.
        const legacy = challengeOf({ falsifierEvidenceId: undefined, resolution: { at: 'x', observed: 'exit 0' } });
        expect(project({ challenges: [legacy] })).toEqual({ independentChallenges: 0, verifiedChallenges: 0 });
    });

    it('counts one reading when one falsifier is reproduced by two challenges', () => {
        expect(project({ challenges: [challengeOf({ id: 'X1' }), challengeOf({ id: 'X2' })] }))
            .toEqual({ independentChallenges: 1, verifiedChallenges: 1 });
    });

    it('credits no discovery reading to matching free-text answers', () => {
        const probes = [probeOf({ id: 'P1-C1' }), probeOf({ id: 'P2-C1' })];
        const answers = [answerOf({ probeId: 'P1-C1' }), answerOf({ probeId: 'P2-C1', observed: 'the probe expected exists' })];
        expect(project({ probes, answers })).toEqual({ independentChallenges: 0, verifiedChallenges: 0 });
    });

    it('does not count an answer to a question this revision no longer asks', () => {
        expect(project({ probes: [probeOf({ subjectRevision: other })], answers: [answerOf({ subjectRevision: other })] }))
            .toEqual({ independentChallenges: 0, verifiedChallenges: 0 });
    });

    it('does not count an answer whose copied fact disagrees with the question', () => {
        expect(project({ probes: [probeOf()], answers: [answerOf({ path: 'src/b.ts' })] }).independentChallenges).toBe(0);
        expect(project({ probes: [probeOf()], answers: [answerOf({ command: 'test -f src/b.ts' })] }).independentChallenges).toBe(0);
        expect(project({ probes: [probeOf()], answers: [answerOf({ subjectRevision: other })] }).independentChallenges).toBe(0);
    });

    it('does not count a legacy answer that carries no fact at all', () => {
        const legacy = answerOf({ subjectRevision: undefined, path: undefined, expected: undefined });
        expect(project({ probes: [probeOf()], answers: [legacy] })).toEqual({ independentChallenges: 0, verifiedChallenges: 0 });
    });

    it('does not count even a blank answer as discovery', () => {
        expect(project({ probes: [probeOf()], answers: [answerOf({ observed: '   ' })] }))
            .toEqual({ independentChallenges: 0, verifiedChallenges: 0 });
    });

    it('never reports a verified reading without a candidate attempt', () => {
        // The two numbers are views of one map, so this can only hold if they are derived together. It is the property the
        // separate derivations could not have: a verified count that exceeds the attempts it was drawn from.
        const cases: Array<{ challenges?: Challenge[]; probes?: Probe[]; answers?: ProbeAnswer[] }> = [
            {},
            { challenges: [challengeOf()] },
            { challenges: [challengeOf({ falsifierEvidenceId: undefined, resolution: undefined })] },
            { probes: [probeOf()], answers: [answerOf()] },
            { probes: [probeOf({ subjectRevision: other })], answers: [answerOf({ subjectRevision: other })] },
            { challenges: [challengeOf(), challengeOf({ id: 'X2' })], probes: [probeOf()], answers: [answerOf(), answerOf({ probeId: 'P2-C1' })] },
        ];
        for (const input of cases) {
            const counts = project(input);
            expect(counts.verifiedChallenges).toBeLessThanOrEqual(counts.independentChallenges);
        }
    });

    it('reports nothing at all when the ledger holds no bound record', () => {
        expect(project()).toEqual({ independentChallenges: 0, verifiedChallenges: 0 });
    });

    it('does not credit a binding to a falsifier the ledger never declared', () => {
        // **The challenge cannot certify its own binding.** A record can name an id the ledger never declared — it is
        // reachable without tooling, because `challenges.json` has no schema — and a resolution that repeats the same id
        // used to be enough to satisfy the discovery floor. The declaration is an input, so an id outside it credits
        // nothing while the attempt is still counted as an attempt.
        const challenge = challengeOf();
        expect(project({ challenges: [challenge] }).verifiedChallenges).toBe(1);
        // **The attempt is not counted either.** A challenge naming a falsifier the ledger never declared is not an attempt
        // at anything the change declared, so the honest refusal is `discovery_floor` ("record one") rather than
        // `discovery_unverified` ("the recorded attempt decided nothing") — counting it as an attempt would let a fabricated
        // record choose which refusal it gets.
        expect(project({ challenges: [challenge], declaredFalsifiers: new Set(['E-OTHER']) })).toEqual({
            independentChallenges: 0,
            verifiedChallenges: 0,
        });
        expect(project({ challenges: [challenge], declaredFalsifiers: new Set() }).verifiedChallenges).toBe(0);
    });

    it('does not credit a resolution the ledger recorded no run for', () => {
        // **An account is not the run.** The resolution says what the challenge saw; `verdicts.json` is the ledger's record of
        // a verifier having run, and only `evidence verify` writes there. A hand-written `challenges.json` — a schema-less
        // file — could otherwise assert a supported verdict at the current revision and satisfy the floor by itself.
        const challenge = challengeOf();
        expect(project({ challenges: [challenge], recordedVerdicts: [] }).verifiedChallenges).toBe(0);
        expect(project({ challenges: [challenge], recordedVerdicts: [recordedVerdict({ verdict: 'refuted' })] }).verifiedChallenges).toBe(0);
        expect(project({ challenges: [challenge], recordedVerdicts: [recordedVerdict({ subjectRevision: 'rev:other' })] }).verifiedChallenges).toBe(0);
        expect(project({ challenges: [challenge] }).verifiedChallenges).toBe(1);
    });

    it('credits nothing when the declaration is not supplied at all', () => {
        // An absent set is not a permissive default: a binding that cannot be checked against a declaration is not
        // evidence, and defaulting to "assume it is declared" is exactly the fail-open shape this projection removes.
        const counts = discoveryProjection({
            challenges: [challengeOf()],
            probes: [],
            answers: [],
            currentRevision: revision,
        });
        expect(counts.verifiedChallenges).toBe(0);
    });
});
