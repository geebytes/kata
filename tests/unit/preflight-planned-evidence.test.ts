import { deferredChecks, executedChecks, type CheckCommand } from '../../src/quality/evidence.js';
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

    it('excludes a covered check too, because it produces no evidence either', () => {
        const covered: CheckCommand = { id: 'covered-check', kind: 'test', command: 'true', args: [], cwd: '/', coveredBy: 'seal-check' };

        // Both are declared and neither runs: this is the set anyone reasoning about the run's evidence must use, and
        // the preflight counted a covered check as planned until it was routed through here.
        expect(executedChecks([frozen, covered, sealTier, untiered], false).map((check) => check.id))
            .toEqual(['seal-check', 'plain-check']);
        expect(executedChecks([frozen, covered, sealTier, untiered], true).map((check) => check.id))
            .toEqual(['frozen-check', 'seal-check', 'plain-check']);
    });

    it('does not call an obligation answerable on the strength of a check the run will defer', () => {
        const planned = [frozen];
        const willRun = executedChecks(planned, false);

        // What the run will actually produce: this is what the resolver will see.
        const produced = willRun.map((check) => envelope(check.id!));

        // The preflight's set is now the same one, so its verdict matches what the resolver will find — which was the
        // whole point: the over-promise was the preflight counting a check the collector was going to skip.
        // The obligation here has a finding behind it, so the reddening has to be supplied or the verdict is false for a
        // reason this case is not about — the case is about which checks the run will actually produce.
        const reddenings = [{ findingId: obligation.findingId!, check: 'tests/unit/fixture.test.ts', mutation: 'the fixture re-introduced the defect', revisionId: 'revision-one', reddenedAt: '2026-09-23T02:00:00.000Z', observed: { before: 0, mutated: 1, after: 0 } }];
        expect(obligationIsAnswered({ obligation, revisionId: 'revision-one', resolvedAcceptanceIds: ['AC-1'], evidence: produced, reddenings }).answered).toBe(false);
        // And with a seal-tier check present, both agree it is answerable.
        const withSealTier = executedChecks([frozen, sealTier], false);
        expect(obligationIsAnswered({ obligation, revisionId: 'revision-one', resolvedAcceptanceIds: ['AC-1'], evidence: withSealTier.map((check) => envelope(check.id!)), reddenings }).answered).toBe(true);
    });
});
