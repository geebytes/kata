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
describe('the closure bound is the route, not a constant field', () => {
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

    it('carries no `mayClose`, because nothing read it and a constant is not a bound', async () => {
        // Read the source rather than assert on an empty object literal: the claim is about the shape the router publishes,
        // and a check that cannot fail for any input would be the same defect in a different place.
        const source = (await readFile('src/workflow/navigation.ts', 'utf8'))
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, '');
        expect(source).not.toContain('mayClose');
        // And the data behind the bound is still published, so removing the constant did not remove the fact.
        expect(source).toContain('unsupportedClaims');
    });
});