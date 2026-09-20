import { describe, expect, it } from 'vitest';
import { checkInputFingerprint, type CheckCommand, type EvidenceEnvelope } from '../../src/quality/evidence.js';
import { planCheckReuse, reusableCheckId } from '../../src/quality/check-reuse.js';

/**
 * L1-01: one changed artefact must not re-run the checks that have nothing to do with it.
 *
 * The rule has a fail-closed half that matters more than the reuse half: every case the plan cannot prove is a case it
 * runs. These tests pin both halves, because a reuse rule that is merely optimistic is a gate that stops checking.
 */
describe('check-level reuse', () => {
    const check = (id: string, args: string[] = []): CheckCommand => ({ id, kind: 'test', command: 'node', args });

    const envelope = (id: string, overrides: Partial<EvidenceEnvelope> = {}): EvidenceEnvelope => ({
        id: `evidence-${id}`,
        taskId: 'reuse-task',
        checkId: id,
        kind: 'test',
        command: 'node',
        exitCode: 0,
        passed: true,
        checkInput: checkInputFingerprint(check(id)),
        startedAt: '2026-09-20T00:00:00.000Z',
        finishedAt: '2026-09-20T00:00:01.000Z',
        diffHash: 'a'.repeat(64),
        ...overrides,
    });

    it('reuses a check whose recorded input is unchanged and previously passed', () => {
        const plan = planCheckReuse([check('lint'), check('unit')], [envelope('lint'), envelope('unit')]);

        expect(plan.reusable.map((entry) => entry.checkId)).toEqual(['lint', 'unit']);
        expect(plan.invalidated).toEqual([]);
        // A reused check is expressed as a known result, which is how the collector already skips execution.
        expect(plan.planned[0]?.importResult).toEqual({ exitCode: 0 });
        expect(plan.planned[0]?.reusedFrom).toBe('evidence-lint');
    });

    it('re-runs only the check whose input changed', () => {
        const plan = planCheckReuse([check('lint'), check('unit', ['--changed'])], [envelope('lint'), envelope('unit')]);

        expect(plan.reusable.map((entry) => entry.checkId)).toEqual(['lint']);
        expect(plan.invalidated).toEqual([{ checkId: 'unit', reason: 'input_changed' }]);
        expect(plan.planned[1]?.importResult).toBeUndefined();
    });

    it('never reuses a check that previously failed', () => {
        const plan = planCheckReuse([check('unit')], [envelope('unit', { exitCode: 1, passed: false })]);

        expect(plan.reusable).toEqual([]);
        expect(plan.invalidated).toEqual([{ checkId: 'unit', reason: 'previously_failed' }]);
    });

    it('refuses to reuse an envelope with no recorded fingerprint', () => {
        const legacy = envelope('unit');
        delete legacy.checkInput;

        const plan = planCheckReuse([check('unit')], [legacy]);

        // Absence is an invalidation, never an assumption of sameness.
        expect(plan.reusable).toEqual([]);
        expect(plan.invalidated).toEqual([{ checkId: 'unit', reason: 'no_input_fingerprint' }]);
    });

    it('addresses a check by the same id the revision was computed over', () => {
        expect(reusableCheckId({ kind: 'test', command: 'node', args: ['a'] })).toBe('test:node:a');
        expect(reusableCheckId(check('lint'))).toBe('lint');
    });
});
