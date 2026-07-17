import { describe, expect, it } from 'vitest';
import {
  defaultWorkflowProfile,
  isWorkflowProfile,
  profileGuardInstructions,
  type WorkflowProfile,
} from '../../src/core/workflow-profile.js';

describe('workflow profile', () => {
  it('uses safe non-interactive defaults and requires Comet open acknowledgement', () => {
    expect(defaultWorkflowProfile()).toEqual({
      version: 1,
      isolationMode: 'current_worktree',
      developmentMode: 'tdd',
      reviewMode: 'std',
      comet: { projectInit: 'not_requested', openStatus: 'required' },
    });
  });

  it('accepts only the persisted workflow profile vocabulary', () => {
    const profile: WorkflowProfile = {
      version: 1,
      isolationMode: 'isolated_worktree',
      developmentMode: 'standard',
      reviewMode: 'security',
      comet: { projectInit: 'initialized', openStatus: 'acknowledged' },
    };
    expect(isWorkflowProfile(profile)).toBe(true);
    expect(isWorkflowProfile({ ...profile, reviewMode: 'anything' })).toBe(false);
    expect(isWorkflowProfile({ ...profile, isolationMode: 'git_flow' })).toBe(true);
    expect(isWorkflowProfile({ ...profile, gitFlow: { strategy: 'manual', branch: 'feature/task', baseBranch: 'develop', status: 'unknown' } })).toBe(false);
  });

  it('tells implementers how to honor the Git Flow isolation choice', () => {
    const profile = {
      ...defaultWorkflowProfile(),
      isolationMode: 'git_flow' as const,
      gitFlow: { strategy: 'manual' as const, branch: 'feature/sample-task', baseBranch: 'develop', status: 'active' as const },
    };
    expect(profileGuardInstructions(profile, 'implementer')).toContain('Work on feature/sample-task; do not start, finish, or switch Git Flow branches outside the recorded task action.');
  });

  it('derives TDD and strict-review instructions from the profile', () => {
    const profile: WorkflowProfile = {
      version: 1,
      isolationMode: 'user_decides',
      developmentMode: 'tdd',
      reviewMode: 'strict',
      comet: { projectInit: 'skipped', openStatus: 'acknowledged' },
    };
    expect(profileGuardInstructions(profile, 'implementer')).toContain('Use TDD: write a focused failing test, verify RED, implement the minimum, then verify GREEN.');
    expect(profileGuardInstructions(profile, 'reviewer')).toContain('Strict review: inspect architecture boundaries, regression risk, and missing focused tests.');
  });
});
