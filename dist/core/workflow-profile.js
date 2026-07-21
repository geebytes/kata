export const isolationModes = ['current_worktree', 'isolated_worktree', 'git_flow', 'user_decides'];
export const developmentModes = ['tdd', 'standard'];
export const reviewModes = ['std', 'strict', 'security'];
export const cometProjectInitStatuses = ['not_requested', 'initialized', 'skipped', 'failed'];
export const cometOpenStatuses = ['required', 'acknowledged'];
export function defaultWorkflowProfile() {
    return { version: 1, isolationMode: 'current_worktree', developmentMode: 'tdd', reviewMode: 'std', comet: { projectInit: 'not_requested', openStatus: 'required' } };
}
export function isWorkflowProfile(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const candidate = value;
    return candidate.version === 1
        && isolationModes.includes(candidate.isolationMode)
        && developmentModes.includes(candidate.developmentMode)
        && reviewModes.includes(candidate.reviewMode)
        && typeof candidate.comet === 'object'
        && candidate.comet !== null
        && cometProjectInitStatuses.includes(candidate.comet.projectInit)
        && cometOpenStatuses.includes(candidate.comet.openStatus)
        && (candidate.gitFlow === undefined || isGitFlowState(candidate.gitFlow));
}
export function profileGuardInstructions(profile, role) {
    if (!profile)
        return [];
    const instructions = [];
    if (profile.isolationMode === 'isolated_worktree')
        instructions.push('Use the selected isolated worktree; do not silently move or recreate the current session worktree.');
    if (profile.isolationMode === 'git_flow' && profile.gitFlow?.status === 'active')
        instructions.push(`Work on ${profile.gitFlow.branch}; do not start, finish, or switch Git Flow branches outside the recorded task action.`);
    if (profile.isolationMode === 'git_flow' && profile.gitFlow?.status !== 'active')
        instructions.push('Git Flow branch creation is pending or failed; do not start, finish, or switch branches until the recorded task action succeeds.');
    if (profile.isolationMode === 'user_decides')
        instructions.push('Ask the user to choose current versus isolated worktree before implementation changes.');
    if (role === 'implementer' && profile.developmentMode === 'tdd')
        instructions.push('Use TDD: write a focused failing test, verify RED, implement the minimum, then verify GREEN.');
    if (role === 'reviewer' && profile.reviewMode === 'strict')
        instructions.push('Strict review: inspect architecture boundaries, regression risk, and missing focused tests.');
    if (role === 'reviewer' && profile.reviewMode === 'security')
        instructions.push('Security review: inspect trust boundaries, secrets, dependency changes, input validation, and authorization effects.');
    return instructions;
}
export async function acknowledgeCometOpen(root, taskId) {
    const { readFile, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const path = join(root, '.kata/tasks', taskId, 'task.json');
    const task = JSON.parse(await readFile(path, 'utf8'));
    const profile = isWorkflowProfile(task.workflowProfile) ? task.workflowProfile : defaultWorkflowProfile();
    const next = { ...profile, comet: { ...profile.comet, openStatus: 'acknowledged' } };
    task.workflowProfile = next;
    await writeFile(path, `${JSON.stringify(task, null, 2)}\n`, 'utf8');
    return next;
}
export async function updateGitFlowProfile(root, taskId, gitFlow) {
    const { readFile, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const path = join(root, '.kata/tasks', taskId, 'task.json');
    const task = JSON.parse(await readFile(path, 'utf8'));
    const profile = isWorkflowProfile(task.workflowProfile) ? task.workflowProfile : defaultWorkflowProfile();
    const next = { ...profile, gitFlow };
    task.workflowProfile = next;
    await writeFile(path, `${JSON.stringify(task, null, 2)}\n`, 'utf8');
    return next;
}
function isGitFlowState(value) {
    if (typeof value !== 'object' || value === null)
        return false;
    const state = value;
    return (state.strategy === 'git-flow' || state.strategy === 'manual')
        && typeof state.branch === 'string'
        && typeof state.baseBranch === 'string'
        && (state.status === 'active' || state.status === 'pending_confirmation' || state.status === 'failed');
}
//# sourceMappingURL=workflow-profile.js.map