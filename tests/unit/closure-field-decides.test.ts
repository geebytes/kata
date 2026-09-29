import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { suggestCandidateAction, type UpstreamSummary } from '../../src/workflow/navigation.js';

/**
 * **The closure bound has to decide something.**
 *
 * `ledgerClosure` carried a `mayClose: boolean` that both writers set to `false` and nothing read: a constant dressed as a
 * bound, and the same shape as a field with a producer and no consumer. The closure *decision* is the route, and the
 * ledger's own verdict already answers it — so the constant is not carried, and the data behind the bound still is.
 */
describe('the closure bound is the route, not a field', () => {
    const base = {
        phase: 'review',
        reviewRecordReadable: true,
        reviewFindings: { blocking: 0, major: 0, minor: 0 },
        ledger: null,
    } as unknown as UpstreamSummary;

    it('routes an unsupported claim to the deficits that would answer it', () => {
        const action = suggestCandidateAction('review', {
            ...base,
            ledger: { state: 'decided', verdict: 'insufficient', claims: 1, reason: 'claims are not supported', deficits: ['C-1'] },
        } as UpstreamSummary);
        expect(action.reason).toBe('satisfy_ledger_deficits');
    });

    it('carries no closure field at all, because the route is the decision', async () => {
        // **A removed field, asserted where it would have been published.** The previous version of this case asserted only
        // that a nested `mayClose` had gone, and an independent review measured what that left: the outer field was still
        // declared, still written by two branches, and read by no production code — the same writer-without-reader shape,
        // one level up. The assertion is now on the whole name, in the source that would have declared it.
        const source = (await readFile('src/workflow/navigation.ts', 'utf8'))
            .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))
            .replace(/^\s*\/\/.*$/gm, '');
        expect(source).not.toContain('ledgerClosure');
        expect(source).not.toContain('roundClosure');
        // And the fact it used to report is still reachable through the ledger, which is what decides.
        expect(source).toContain("'satisfy_ledger_deficits'");
    });
});
