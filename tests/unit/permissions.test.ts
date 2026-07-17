import { describe, expect, it } from 'vitest';
import { validateWrite, type Actor } from '../../src/policy/permissions.js';
import type { TaskRecord } from '../../src/core/task.js';

describe('policy permissions', () => {
  const task: TaskRecord = {
    id: 'task-5',
    title: 'Bounded repair',
    phase: 'implement',
    acceptance: [{ id: 'AC-1', statement: 'Repair is bounded.' }],
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
  };

  it('lets implementers write task code and tests but not protected rules', () => {
    const actor: Actor = { id: 'agent-1', role: 'implementer' };

    expect(validateWrite(actor, 'src/policy/model-policy.ts', task)).toEqual({ allowed: true });
    expect(validateWrite(actor, 'tests/unit/model-policy.test.ts', task)).toEqual({ allowed: true });
    expect(validateWrite(actor, 'docs/superpowers/rules/verified.md', task)).toEqual({
      allowed: false,
      reason: 'protected_rules_or_verified_wiki',
    });
  });

  it('keeps verified Wiki promotion behind explicit authority', () => {
    const distiller: Actor = { id: 'agent-2', role: 'distiller' };
    const approver: Actor = { id: 'human-1', role: 'approver' };

    expect(validateWrite(distiller, '.kata/wiki/candidates/task-5.json', task)).toEqual({ allowed: true });
    expect(validateWrite(distiller, '.kata/wiki/verified/task-5.json', task)).toEqual({
      allowed: false,
      reason: 'protected_rules_or_verified_wiki',
    });
    expect(validateWrite(approver, '.kata/wiki/verified/task-5.json', task)).toEqual({ allowed: true });
  });

  it('rejects traversal that would escape candidate Wiki into verified Wiki', () => {
    const distiller: Actor = { id: 'agent-2', role: 'distiller' };

    expect(validateWrite(distiller, 'wiki/candidates/../verified/task-5.md', task)).toEqual({
      allowed: false,
      reason: 'invalid_path',
    });
    expect(validateWrite(distiller, 'wiki\\candidates\\..\\verified\\task-5.md', task)).toEqual({
      allowed: false,
      reason: 'invalid_path',
    });
  });

  it('rejects traversal that would escape allowed code paths into protected rules', () => {
    const actor: Actor = { id: 'agent-1', role: 'implementer' };

    expect(validateWrite(actor, 'src/../docs/superpowers/rules/verified.md', task)).toEqual({
      allowed: false,
      reason: 'invalid_path',
    });
    expect(validateWrite(actor, 'tests\\..\\wiki\\verified\\task-5.md', task)).toEqual({
      allowed: false,
      reason: 'invalid_path',
    });
  });

  it('restricts reviewer and judge writes to their structured task artifacts', () => {
    expect(validateWrite({ id: 'reviewer-1', role: 'reviewer' }, '.kata/tasks/task-5/review.json', task)).toEqual({
      allowed: true,
    });
    expect(validateWrite({ id: 'reviewer-1', role: 'reviewer' }, 'src/core/task.ts', task)).toEqual({
      allowed: false,
      reason: 'role_scope_violation',
    });
    expect(validateWrite({ id: 'judge-1', role: 'judge' }, '.kata/tasks/task-5/judge.json', task)).toEqual({
      allowed: true,
    });
  });
});
