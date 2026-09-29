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

    it('breaks a tie on the run id rather than on the position, so a document edited by hand cannot reorder the answer', () => {
        const sameMoment = (runId: string): EvidenceVerdict =>
            reading({ evidenceId: 'E1', verdict: runId === 'run-b' ? 'supported' : 'inconclusive', at: '2026-09-29T00:00:00.000Z', producer: { runId, actor: 'a' } });
        expect(projectVerdicts([sameMoment('run-a'), sameMoment('run-b')]).map((entry) => entry.verdict)).toEqual(['supported']);
        expect(projectVerdicts([sameMoment('run-b'), sameMoment('run-a')]).map((entry) => entry.verdict)).toEqual(['supported']);
    });
});
