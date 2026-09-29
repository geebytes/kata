import { describe, expect, it } from 'vitest';
import { projectVerdicts } from '../../src/kernel/evidence.js';
import type { EvidenceVerdict } from '../../src/kernel/types.js';

/**
 * **One item, several readings, one answer — decided by a rule, not by the order of the list.**
 *
 * Keeping every reading per run means an item can have more than one answer, and the claim is judged on one of them. The
 * rule is stated here so it cannot be "whichever the document happened to list first": a refuted reading wins, because a
 * reproducible counterexample is not outvoted anywhere else in this kernel; otherwise the newest wins, by a total order.
 */
function reading(overrides: Partial<EvidenceVerdict> & { evidenceId: string }): EvidenceVerdict {
    return {
        evidenceType: 'executable_falsifier',
        verdict: 'supported',
        observed: 'exit 0',
        at: '2026-09-29T00:00:00.000Z',
        verifier: 'producers/verifiers#executable',
        subjectRevision: 'rev:1',
        ...overrides,
    };
}

describe('a reading about another revision does not decide this one', () => {
    const CURRENT = 'rev:current';
    const OLD = 'rev:old';

    it('does not let a refutation of an older revision outrank support for the current one', () => {
        // **Measured by an independent review, and a regression this change introduced.** The store used to replace on the
        // evidence id, so a later reading about the current revision simply replaced an earlier refutation of an older one.
        // Once both are kept, refuted-priority applied across revisions made the item refuted *forever*: the projection
        // reports the reading it picked, and the store only drops verdicts for an evidence item whose content changed — so
        // re-reading, which is the remedy `decide` names, could never clear it.
        const projected = projectVerdicts(
            [
                reading({ evidenceId: 'E1', verdict: 'refuted', at: '2026-09-28T00:00:00.000Z', subjectRevision: OLD }),
                reading({ evidenceId: 'E1', verdict: 'supported', at: '2026-09-29T12:00:00.000Z', subjectRevision: CURRENT }),
            ],
            { currentRevision: CURRENT },
        );
        expect(projected.map((entry) => `${entry.verdict}@${entry.subjectRevision}`)).toEqual([`supported@${CURRENT}`]);
    });

    it('still lets a refutation of the current revision win, which is the whole point of keeping it', () => {
        const projected = projectVerdicts(
            [
                reading({ evidenceId: 'E1', verdict: 'refuted', at: '2026-09-29T00:00:00.000Z', subjectRevision: CURRENT }),
                reading({ evidenceId: 'E1', verdict: 'supported', at: '2026-09-29T12:00:00.000Z', subjectRevision: CURRENT }),
            ],
            { currentRevision: CURRENT },
        );
        expect(projected.map((entry) => entry.verdict)).toEqual(['refuted']);
    });

    it('falls back to the newest reading when nothing was read against this revision, so the item is reported stale', () => {
        // The state a re-seal creates before anyone re-reads: no reading is about the new revision, and the kernel's answer
        // is staleness for the item — not silence, and not a stale reading pretending to be current.
        const projected = projectVerdicts(
            [
                reading({ evidenceId: 'E1', verdict: 'supported', at: '2026-09-28T00:00:00.000Z', subjectRevision: OLD }),
                reading({ evidenceId: 'E1', verdict: 'inconclusive', at: '2026-09-28T06:00:00.000Z', subjectRevision: OLD }),
            ],
            { currentRevision: CURRENT },
        );
        expect(projected.map((entry) => `${entry.verdict}@${entry.subjectRevision}`)).toEqual([`inconclusive@${OLD}`]);
    });
});

describe('what a claim is judged on when an item has several readings', () => {
    it('is the reading itself when there is only one, so nothing changes for every ledger in existence', () => {
        const only = reading({ evidenceId: 'E1' });
        expect(projectVerdicts([only])).toEqual([only]);
    });

    it('keeps an item refuted even when a later reading supports it', () => {
        // The direction that matters: a second, more optimistic reading must not launder a counterexample into support.
        const projected = projectVerdicts([
            reading({ evidenceId: 'E1', verdict: 'refuted', at: '2026-09-29T00:00:00.000Z' }),
            reading({ evidenceId: 'E1', verdict: 'supported', at: '2026-09-29T01:00:00.000Z' }),
        ]);
        expect(projected.map((entry) => entry.verdict)).toEqual(['refuted']);
    });

    it('takes the newest reading when none of them refutes the item', () => {
        const projected = projectVerdicts([
            reading({ evidenceId: 'E1', verdict: 'inconclusive', at: '2026-09-29T00:00:00.000Z' }),
            reading({ evidenceId: 'E1', verdict: 'supported', at: '2026-09-29T02:00:00.000Z' }),
        ]);
        expect(projected.map((entry) => entry.verdict)).toEqual(['supported']);
    });

    it('answers the same way whatever order the readings are listed in', () => {
        const readings = [
            reading({ evidenceId: 'E1', verdict: 'supported', at: '2026-09-29T00:00:00.000Z', producer: { runId: 'run-1', actor: 'a' } }),
            reading({ evidenceId: 'E1', verdict: 'inconclusive', at: '2026-09-29T03:00:00.000Z', producer: { runId: 'run-2', actor: 'b' } }),
            reading({ evidenceId: 'E1', verdict: 'refuted', at: '2026-09-28T00:00:00.000Z', producer: { runId: 'run-3', actor: 'c' } }),
            reading({ evidenceId: 'E2', verdict: 'supported', at: '2026-09-29T00:00:00.000Z', producer: { runId: 'run-1', actor: 'a' } }),
        ];
        const forward = projectVerdicts(readings).map((entry) => `${entry.evidenceId}:${entry.verdict}`);
        const reversed = projectVerdicts([...readings].reverse()).map((entry) => `${entry.evidenceId}:${entry.verdict}`);
        expect(reversed).toEqual(forward);
        expect(forward).toEqual(['E1:refuted', 'E2:supported']);
    });

    it('answers one entry per evidence item, never more', () => {
        const projected = projectVerdicts([
            reading({ evidenceId: 'E1', producer: { runId: 'run-1', actor: 'a' } }),
            reading({ evidenceId: 'E1', producer: { runId: 'run-2', actor: 'b' } }),
            reading({ evidenceId: 'E1', producer: { runId: 'run-3', actor: 'c' } }),
        ]);
        expect(projected).toHaveLength(1);
    });

    it('orders two refuted readings by time as well, so the newest refutation is the one reported', () => {
        // **Measured by an independent review.** The refuted branch returned before the timestamp was compared, so two
        // refutations were resolved by document position — and since the store appends, the winner was the OLDEST, while its
        // `observed`, `at`, `subjectRevision` and `producer` are what the reader sees.
        const older = reading({ evidenceId: 'E1', verdict: 'refuted', observed: 'failed before', at: '2026-01-01T00:00:00.000Z', producer: { runId: 'run-1', actor: 'a' } });
        const newer = reading({ evidenceId: 'E1', verdict: 'refuted', observed: 'failed differently', at: '2026-09-01T00:00:00.000Z', producer: { runId: 'run-2', actor: 'b' } });
        expect(projectVerdicts([older, newer]).map((entry) => entry.observed)).toEqual(['failed differently']);
        expect(projectVerdicts([newer, older]).map((entry) => entry.observed)).toEqual(['failed differently']);
    });

    it('resolves a same-moment tie by content rather than by position, for the cell the order-independence case misses', () => {
        // Two readings with the same `at` and the same run id cannot come from the store (it would have replaced one), but a
        // hand-written or legacy document can hold them — and then the answer must still not depend on the order.
        const supported = reading({ evidenceId: 'E1', verdict: 'supported', at: '2026-09-29T00:00:00.000Z', producer: { runId: 'run-1', actor: 'a' } });
        const inconclusive = reading({ evidenceId: 'E1', verdict: 'inconclusive', at: '2026-09-29T00:00:00.000Z', producer: { runId: 'run-1', actor: 'a' } });
        expect(projectVerdicts([supported, inconclusive]).map((entry) => entry.verdict)).toEqual(['supported']);
        expect(projectVerdicts([inconclusive, supported]).map((entry) => entry.verdict)).toEqual(['supported']);
    });

    it('never lets an unparseable timestamp win on recency, because a relayed reading writes that string itself', () => {
        const junk = reading({ evidenceId: 'E1', verdict: 'inconclusive', at: 'zzz', producer: { runId: 'run-1', actor: 'a' } });
        const real = reading({ evidenceId: 'E1', verdict: 'supported', at: '2026-09-29T00:00:00.000Z', producer: { runId: 'run-2', actor: 'b' } });
        expect(projectVerdicts([junk, real]).map((entry) => entry.verdict)).toEqual(['supported']);
        expect(projectVerdicts([real, junk]).map((entry) => entry.verdict)).toEqual(['supported']);
        // And two junk timestamps do not fall back to position either: the run id orders them.
        const junkA = reading({ evidenceId: 'E1', verdict: 'inconclusive', at: '{junk}', producer: { runId: 'run-a', actor: 'a' } });
        const junkB = reading({ evidenceId: 'E1', verdict: 'supported', at: 'also-junk', producer: { runId: 'run-b', actor: 'b' } });
        expect(projectVerdicts([junkA, junkB]).map((entry) => entry.verdict)).toEqual(['supported']);
        expect(projectVerdicts([junkB, junkA]).map((entry) => entry.verdict)).toEqual(['supported']);
    });

    it('orders readings that differ only in who verified them, so the reported instance does not depend on the document', () => {
        // Measured by an independent review over random documents: the verdict was always stable, but *which* reading was
        // reported moved with the order for 32 of 4000, because `verifier` was not in the chain.
        const left = reading({ evidenceId: 'E1', verifier: 'producers/verifiers#static-witness', at: '2026-09-29T00:00:00.000Z', producer: { runId: 'run-1', actor: 'a' } });
        const right = reading({ evidenceId: 'E1', verifier: 'producers/verifiers#executable', at: '2026-09-29T00:00:00.000Z', producer: { runId: 'run-1', actor: 'a' } });
        expect(projectVerdicts([left, right]).map((entry) => entry.verifier)).toEqual(projectVerdicts([right, left]).map((entry) => entry.verifier));
    });

    it('orders a verdict the table does not know, rather than leaving it to the document', () => {
        // The rank lookup used to return `undefined` for an unknown verdict, making both comparisons false and handing the
        // answer to the array's order. The reader rejects such a document as malformed, so this is a guard rather than a
        // reachable state — asserted because a table lookup that is total is cheaper than a comment claiming it is.
        const known = reading({ evidenceId: 'E1', verdict: 'inconclusive', at: '2026-09-29T00:00:00.000Z', producer: { runId: 'run-1', actor: 'a' } });
        const unknown = JSON.parse(JSON.stringify({ ...known, verdict: 'endorsed' })) as EvidenceVerdict;
        expect(projectVerdicts([known, unknown]).map((entry) => entry.verdict)).toEqual(projectVerdicts([unknown, known]).map((entry) => entry.verdict));
    });

    it('breaks a tie on the run id rather than on the position, so a document edited by hand cannot reorder the answer', () => {
        const sameMoment = (runId: string): EvidenceVerdict =>
            reading({ evidenceId: 'E1', verdict: runId === 'run-b' ? 'supported' : 'inconclusive', at: '2026-09-29T00:00:00.000Z', producer: { runId, actor: 'a' } });
        expect(projectVerdicts([sameMoment('run-a'), sameMoment('run-b')]).map((entry) => entry.verdict)).toEqual(['supported']);
        expect(projectVerdicts([sameMoment('run-b'), sameMoment('run-a')]).map((entry) => entry.verdict)).toEqual(['supported']);
    });
});
