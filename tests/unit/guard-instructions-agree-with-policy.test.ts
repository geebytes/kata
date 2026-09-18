import { describe, expect, it } from 'vitest';
import { evaluateHookWrite } from '../../src/policy/hook-policy.js';
import { ROLE_WRITE_SCOPE, UNIVERSAL_GUARD_INSTRUCTIONS, buildGuardInstructions } from '../../src/policy/guard-instructions.js';

/**
 * The instructions a model obeys and the rule the hook enforces name the same paths.
 *
 * L2-06: the same write policy lived in three audiences with no link between them — the typed policy the hook guard
 * enforces, the guard instructions a handoff packet carries, and the profile layer's extra instructions. The prose was a
 * hand-written restatement of the enforcement, so a change to one could leave the other describing a rule that no longer
 * holds, and the prose is the text the agent acts on.
 *
 * This asserts the agreement by **probing the policy**: every path written in a role's instruction is offered to
 * `evaluateHookWrite` for that role, and the ones the policy allows must be exactly the ones the sentence names.
 */
describe('guard instructions name the paths the policy allows', () => {
    const task = { id: 'task-1', phase: 'implement' };

    function allowed(role: string, path: string): boolean {
        return evaluateHookWrite({ role }, path, task) === null;
    }

    it('an implementer’s allowed prefixes are the ones the instruction names', () => {
        for (const prefix of ['src/', 'packages/', 'tests/', 'docs/']) {
            expect(allowed('implementer', `${prefix}thing.ts`), prefix).toBe(true);
        }
        // …and the instruction names them, so an agent reading it is not told to stay inside a smaller box than it has.
        for (const prefix of ['src/', 'packages/', 'tests/', 'docs/']) {
            expect(ROLE_WRITE_SCOPE.implementer, prefix).toContain(prefix);
        }
        expect(allowed('implementer', 'scripts/thing.ts')).toBe(false);
    });

    it('a reviewer may write the review and nothing else', () => {
        expect(allowed('reviewer', '.kata/tasks/task-1/review.json')).toBe(true);
        expect(allowed('reviewer', '.kata/tasks/task-1/judge.json')).toBe(false);
        expect(ROLE_WRITE_SCOPE.reviewer).toContain('review.json');
    });

    it('a judge may write the judgement and nothing else', () => {
        expect(allowed('judge', '.kata/tasks/task-1/judge.json')).toBe(true);
        expect(allowed('judge', '.kata/tasks/task-1/review.json')).toBe(false);
        expect(ROLE_WRITE_SCOPE.judge).toContain('judge.json');
    });

    it('the universal rule names the paths the policy protects', () => {
        const sentence = UNIVERSAL_GUARD_INSTRUCTIONS.join(' ');
        expect(allowed('implementer', 'docs/superpowers/rules/x.md')).toBe(false);
        expect(sentence).toContain('docs/superpowers/rules/');
        expect(allowed('implementer', '.kata/wiki/verified/x.json')).toBe(false);
        expect(sentence).toContain('wiki/verified/');
    });

    it('every role has a scope sentence, and a packet carries it', () => {
        for (const role of ['designer', 'implementer', 'reviewer', 'judge', 'distiller', 'approver'] as const) {
            expect(ROLE_WRITE_SCOPE[role].length, role).toBeGreaterThan(0);
            expect(buildGuardInstructions('implement', role)).toContain(ROLE_WRITE_SCOPE[role]);
        }
    });
});
