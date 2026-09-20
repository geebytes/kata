import { deferredChecks, type CheckCommand } from '../../src/quality/evidence.js';
import { obligationIsAnswered } from '../../src/quality/repair-obligations.js';
import { describe, expect, it } from 'vitest';
import type { EvidenceEnvelope } from '../../src/quality/evidence.js';

/**
 * The dry run must be computed over the checks that will actually run.
 *
 * `collectSealPreflight` reasons about the evidence a seal is about to produce, and it built that from **every** planned
 * check with `exitCode: 0`. But a check declared `tier: 'frozen'` is deferred unless `--frozen` is passed, so it produces
 * no evidence at all — and the dry run over-promised. Measured on one obligation: the preflight's verdict over a
 * frozen-only plan was `true` while the same rule over what that plan really produces was `false`, so the seal passed
 * with the obligation still open and nothing reporting it. The fix routes both the collector and the preflight through
 * `deferredChecks`, so the set the preflight reasons about is derived by the same rule the run executes with.
 */
describe('the preflight reasons about the checks that will run', () => {
    const frozen: CheckCommand = { id: 'frozen-check', kind: 'test', command: 'true', args: [], cwd: '/', tier: 'frozen' };
    const sealTier: CheckCommand = { id: 'seal-check', kind: 'test', command: 'true', args: [], cwd: '/', tier: 'seal' };
    const untiered: CheckCommand = { id: 'plain-check', kind: 'test', command: 'true', args: [], cwd: '/' };

    function envelope(id: string): EvidenceEnvelope {
        return {
            id, taskId: 't', kind: 'test', command: 'true', checkId: id, exitCode: 0,
            startedAt: '', finishedAt: '', diffHash: '',
        };
    }

    const obligation = {
        id: 'obligation-1', taskId: 't', source: 'review' as const, findingId: 'f-1',
        severity: 'major' as const, message: 'm', createdAt: '',
    };

    it('defers a frozen-tier check unless the run asks for it', () => {
        expect(deferredChecks([frozen, sealTier, untiered], false)).toEqual([frozen]);
        // `--frozen` is the run saying it wants them, so nothing is deferred.
        expect(deferredChecks([frozen, sealTier, untiered], true)).toEqual([]);
    });

    it('does not call an obligation answerable on the strength of a check the run will defer', () => {
        const planned = [frozen];
        const willRun = planned.filter((check) => !deferredChecks(planned, false).includes(check));

        // What the run will actually produce: this is what the resolver will see.
        const produced = willRun.map((check) => envelope(check.id!));

        // The preflight's set is now the same one, so its verdict matches what the resolver will find — which was the
        // whole point: the over-promise was the preflight counting a check the collector was going to skip.
        expect(obligationIsAnswered({ obligation, resolvedAcceptanceIds: ['AC-1'], evidence: produced }).answered).toBe(false);
        // And with a seal-tier check present, both agree it is answerable.
        const withSealTier = [frozen, sealTier].filter((check) => !deferredChecks([frozen, sealTier], false).includes(check));
        expect(obligationIsAnswered({ obligation, resolvedAcceptanceIds: ['AC-1'], evidence: withSealTier.map((check) => envelope(check.id!)) }).answered).toBe(true);
    });
});
