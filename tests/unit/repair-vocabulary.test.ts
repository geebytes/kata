import { describe, expect, it } from 'vitest';
import { repairScopes, repairableJudgeScopes, repairableVerifyScopes, isRepairableScope } from '../../src/quality/judge.js';
import { renderSkill, skillCommands } from '../../src/adapters/manifest.js';
import { nextActionForTask, nextActionReasons, reasonForUniformScope, trustBoundaryFor, uniformScopeReason } from '../../src/workflow/navigation.js';

/**
 * The repair and next-action vocabularies are closed sets that gate behaviour. These tests fail when a member is added
 * without deciding what it means in each mapping — the compiler already enforces the `Record`s, and this catches the
 * places where a map is not exhaustive at runtime.
 */
describe('repair and next-action vocabularies', () => {
    it('decides a uniform-scope reason for every repair scope', () => {
        for (const scope of repairScopes) {
            expect(Object.hasOwn(reasonForUniformScope, scope)).toBe(true);
        }
        expect(Object.keys(reasonForUniformScope).sort()).toEqual([...repairScopes].sort());
    });

    it('maps a uniform failed set to its reason and a mixed set to null', () => {
        expect(uniformScopeReason(['stale_evidence', 'stale_evidence'])).toBe('rebuild_stale_evidence');
        expect(uniformScopeReason(['revision_superseded'])).toBe('rebuild_superseded_revision');
        expect(uniformScopeReason(['insufficient_evidence_level'])).toBe('add_entrypoint_evidence');
        expect(uniformScopeReason(['unresolved_repair_obligation'])).toBe('resolve_repair_obligations');
        expect(uniformScopeReason(['stale_evidence', 'failing_evidence'])).toBeNull();
        expect(uniformScopeReason([])).toBeNull();
        // Scopes that carry no scope-specific reason fall back to the caller's default.
        expect(uniformScopeReason(['failing_evidence'])).toBeNull();
    });

    it('keeps the two repairable sets derived from one another', () => {
        for (const scope of repairableJudgeScopes) {
            expect(repairableVerifyScopes).toContain(scope);
        }
        // Verify authorises drift repairs, a Judge FAIL does not.
        expect(repairableVerifyScopes).toContain('revision_superseded');
        expect(repairableJudgeScopes).not.toContain('revision_superseded');
        expect(isRepairableScope('stale_evidence', repairableJudgeScopes)).toBe(true);
        expect(isRepairableScope('revision_superseded', repairableJudgeScopes)).toBe(false);
        expect(isRepairableScope(undefined, repairableJudgeScopes)).toBe(false);
    });

    it('decides a trust boundary for every next-action reason', () => {
        const gates: string[] = [];
        for (const reason of nextActionReasons) {
            const boundary = trustBoundaryFor(reason);
            expect(boundary === null || typeof boundary === 'string').toBe(true);
            if (boundary) gates.push(reason);
        }
        expect(gates.sort()).toEqual(['archive_judged_change', 'choose_execution_mode', 'judge_reviewed_change', 'review_fresh_implementation']);
    });

    it('carries the reason through to the action and gates only at trust boundaries', () => {
        for (const reason of nextActionReasons) {
            const action = nextActionForTask('vocabulary-task', '/kata-build', 'implementer', reason);
            expect(action.reason).toBe(reason);
            expect(action.modelOrPlatformSwitchAllowed).toBe(trustBoundaryFor(reason) !== null);
        }
    });

    it('documents every repair scope in the generated skill text', () => {
        const verify = skillCommands.find((command) => command.id === 'kata-verify');
        expect(verify).toBeDefined();
        const rendered = renderSkill(verify!, 'generic');

        for (const scope of repairScopes) {
            expect(rendered).toContain(`\`${scope}\``);
        }
    });
});
