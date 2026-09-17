import { describe, expect, it } from 'vitest';
import { orderedPhases, type Phase } from '../../src/core/state.js';
import {
    activeRoleByPhase,
    activeRoleForPhase,
    nextActionForTask,
    nextActionReasons,
    nextSkillForPhase,
    phaseFallback,
    suggestCandidateAction,
    type UpstreamSummary,
} from '../../src/workflow/navigation.js';
import { roleForPhase } from '../../src/cli.js';

/**
 * "What happens next" used to be computed by two engines with duplicated literals: the dispatcher's ladder in
 * navigation and a second, priority-less ladder inside `cmdVerify`. These tests pin the one resolver both now use, and
 * the phase tables the CLI, the hook and the dispatcher read.
 */
describe('next-action resolver', () => {
    function upstream(overrides: Partial<UpstreamSummary> = {}): UpstreamSummary {
        return {
            failedAcceptance: 0,
            failedVerifyAcceptance: 0,
            repairScopes: [],
            verifyRepairScopes: [],
            evidenceFiles: [],
            failingEvidence: 0,
            ...overrides,
        } as UpstreamSummary;
    }

    it('gives every phase one fallback action drawn from the same table as nextSkillForPhase', () => {
        for (const phase of orderedPhases) {
            const action = phaseFallback[phase];
            expect(action.nextSkill).toBe(nextSkillForPhase(phase));
            expect(nextActionReasons).toContain(action.reason);
            expect(typeof action.role).toBe('string');
            expect(Number.isFinite(action.priority)).toBe(true);
        }
    });

    it('activates a task in the same role the hook accepts', () => {
        for (const phase of orderedPhases) {
            expect(activeRoleForPhase(phase)).toBe(activeRoleByPhase[phase]);
            // The CLI's role for a phase is the activation role, not the role that acts next.
            expect(roleForPhase(phase)).toBe(activeRoleForPhase(phase));
        }
    });

    it('maps a verify FAIL through the shared scope table instead of a second ladder', () => {
        const suggestion = suggestCandidateAction('hardVerify', upstream({ verifyResult: 'FAIL', verifyRepairScopes: ['revision_superseded'] }));
        expect(suggestion).toMatchObject({ nextSkill: '/kata-build', role: 'implementer', reason: 'rebuild_superseded_revision' });

        const unmapped = suggestCandidateAction('hardVerify', upstream({ verifyResult: 'FAIL', verifyRepairScopes: ['failing_evidence'] }));
        expect(unmapped.reason).toBe('repair_failed_verify');
    });

    it('sends a verified task to review or judge depending on its phase', () => {
        expect(suggestCandidateAction('hardVerify', upstream({ verifyResult: 'PASS' })))
            .toMatchObject({ nextSkill: '/kata-review', role: 'reviewer', reason: 'review_fresh_implementation' });
        // A review that has not concluded yet asks the reviewer to finish; a concluded one hands over to the Judge.
        expect(suggestCandidateAction('review', upstream({ reviewReady: false })))
            .toMatchObject({ nextSkill: '/kata-review', role: 'reviewer', reason: 'complete_review_conclusion' });
        expect(suggestCandidateAction('review', upstream({ reviewReady: true })))
            .toMatchObject({ nextSkill: '/kata-judge', role: 'judge', reason: 'judge_reviewed_change' });
    });

    it('asks for Wiki closure before review when verify ran clean but the closure is open', () => {
        const suggestion = suggestCandidateAction('hardVerify', upstream({
            verifyResult: 'FAIL',
            wikiClosureValid: false,
            failedVerifyAcceptance: 0,
        }));

        expect(suggestion).toMatchObject({ nextSkill: '/kata-wiki-enrich', role: 'implementer', reason: 'resolve_wiki_closure' });
    });

    it('still asks for verification when nothing has been verified yet', () => {
        expect(suggestCandidateAction('hardVerify', upstream({ wikiClosureValid: false })))
            .toMatchObject({ nextSkill: '/kata-verify', reason: 'verify_fresh_implementation' });
    });

    it('turns a suggestion into the full action contract', () => {
        const suggestion = suggestCandidateAction('hardVerify', upstream({ verifyResult: 'PASS' }));
        const action = nextActionForTask('resolver-task', suggestion.nextSkill, suggestion.role, suggestion.reason);

        expect(action).toMatchObject({
            taskId: 'resolver-task',
            nextSkill: '/kata-review',
            role: 'reviewer',
            reason: 'review_fresh_implementation',
            requiresUserConfirmation: true,
            trustBoundary: 'review_gate',
        });
        expect(action.slashCommand).toBe('/kata-review resolver-task');
    });

    it('appends --seal only for the rebuild reasons', () => {
        expect(nextActionForTask('resolver-task', '/kata-build', 'implementer', 'rebuild_stale_evidence').slashCommand)
            .toBe('/kata-build resolver-task --seal');
        expect(nextActionForTask('resolver-task', '/kata-build', 'implementer', 'repair_failed_verify').slashCommand)
            .toBe('/kata-build resolver-task');
    });

    it('keeps every phase reachable through the resolver', () => {
        for (const phase of orderedPhases) {
            const suggestion = suggestCandidateAction(phase satisfies Phase, upstream());
            expect(nextActionReasons).toContain(suggestion.reason);
            expect(suggestion.nextSkill).toMatch(/^\/kata/);
        }
    });
});
