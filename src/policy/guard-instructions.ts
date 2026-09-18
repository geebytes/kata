import type { Role } from '../workflow/handoff.js';
import type { WorkflowProfile } from '../core/workflow-profile.js';

/**
 * The write policy as **instructions the model reads**, generated from the declarations the hook enforces.
 *
 * L2-06: the same rule lived in three audiences with no link between them — the typed policy the hook guard enforces
 * (`policy/hook-policy.ts`), the guard instructions a handoff packet carries ("Write only to src/, tests/, and
 * task-owned .kata paths.") and the profile layer's extra instructions. The prose was a hand-written restatement of the
 * enforcement, so it could drift from it silently — and the prose is the text an agent actually obeys.
 *
 * The fix is not to generate the sentences from the policy source (the policy is predicates, these are guidance), but to
 * put both in one file and to state each role's scope **once**: `ROLE_WRITE_SCOPE` below is the instruction, and it is
 * written to name the same paths the policy allows. `policy/guard-instructions.test.ts` asserts the agreement by
 * probing the policy itself, so a change to one without the other fails.
 */

/** Where each role may write, as the model is told it. The paths are the ones `evaluateHookWrite` permits. */
export const ROLE_WRITE_SCOPE: Record<Role, string> = {
    implementer: 'Write only to src/, packages/, tests/, docs/, and task-owned .kata paths.',
    designer: 'Write only to task design artifacts, docs/, and task-owned .kata paths.',
    reviewer: 'You may only write review findings to review.json.',
    judge: 'You may only write the judge result to judge.json.',
    distiller: 'You may only write Wiki candidates to .kata/wiki/.',
    approver: 'You may write anywhere, but protected rules and verified Wiki pages are still governance-only.',
};

/** The rules every role is told, regardless of scope. */
export const UNIVERSAL_GUARD_INSTRUCTIONS: readonly string[] = [
    'Do not modify .kata/schemas/, docs/superpowers/rules/, or wiki/verified/.',
];

/** One sentence, one place: the host-model policy is stated verbatim wherever the product states it. */
export const HOST_MODEL_POLICY_SENTENCE =
    'Kata does not configure, route or record the host platform\'s model; the choice is the user\'s, in their own platform.';

/** Per-role instructions beyond the write scope. */
const ROLE_INSTRUCTIONS: Record<Role, readonly string[]> = {
    implementer: ['All acceptance criteria must have stable AC-[0-9]+ ids before implement.'],
    designer: ['Clarify acceptance criteria before implementation.', 'Do not modify implementation files during design.'],
    reviewer: ['Check that acceptance criteria are met by the implementation.', 'Assign severity: blocking (must fix), major, minor, note.'],
    judge: ['Evaluate each acceptance criterion independently.', 'Return PASS only if all criteria have fresh passing test evidence and no blocking findings.'],
    distiller: ['Only promote candidates from tasks with Judge PASS.', 'Include source references, hashes, and evidence links.'],
    approver: [],
};

/** Profile-driven instructions: the isolation and mode the task declared, as guidance. */
export function profileGuardInstructions(profile: WorkflowProfile | undefined, role: string): string[] {
    if (!profile) return [];
    const instructions: string[] = [];
    if (profile.isolationMode === 'isolated_worktree') instructions.push('Use the isolated worktree: run `kata-cli worktree create --change <task>` (linked worktrees live under .kata/worktrees/) and work there; do not silently move or recreate the current session worktree.');
    if (profile.isolationMode === 'git_flow' && profile.gitFlow?.status === 'active') instructions.push(`Work on ${profile.gitFlow.branch}; do not start, finish, or switch Git Flow branches outside the recorded task action.`);
    if (profile.isolationMode === 'git_flow' && profile.gitFlow?.status !== 'active') instructions.push('Git Flow branch creation is pending or failed; do not start, finish, or switch branches until the recorded task action succeeds.');
    if (profile.isolationMode === 'user_decides') instructions.push('Ask the user to choose current versus isolated worktree before implementation changes; `kata-cli worktree create --change <task>` creates kata\'s isolated worktree, and `kata-cli worktree list` shows the existing ones.');
    if (role === 'implementer' && profile.developmentMode === 'tdd') instructions.push('Use TDD: write a focused failing test, verify RED, implement the minimum, then verify GREEN.');
    if (role === 'reviewer' && profile.reviewMode === 'strict') instructions.push('Strict review: inspect architecture boundaries, regression risk, and missing focused tests.');
    if (role === 'reviewer' && profile.reviewMode === 'security') instructions.push('Security review: inspect trust boundaries, secrets, dependency changes, input validation, and authorization effects.');
    return instructions;
}

/** The guard instructions a handoff packet carries for the role that is about to act. */
export function buildGuardInstructions(phase: string, nextRole: Role): string[] {
    const instructions: string[] = [ROLE_WRITE_SCOPE[nextRole], ...UNIVERSAL_GUARD_INSTRUCTIONS];
    if (phase === 'hardVerify' || phase === 'review' || phase === 'judge') {
        instructions.push('Record the verdict where the workflow reads it, and let kata decide what the next phase is.');
    }
    if (nextRole === 'implementer') {
        instructions.push('Do not edit the task\'s acceptance after sealing; a changed acceptance is a new design, not a repair.');
    }
    return [...instructions, ...ROLE_INSTRUCTIONS[nextRole]];
}
