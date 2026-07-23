import { describe, expect, it } from 'vitest';
import { validate } from '../../src/core/schema.js';

type WikiRecord = {
  status: 'candidate' | 'verified' | 'stale' | 'rejected';
};

describe('Kata schema validation', () => {
  it('validates task records while allowing acceptance ids to be assigned before implement', () => {
    const validTask = {
      id: 'task-2',
      title: 'Define schemas and layout',
      phase: 'intake',
      acceptance: [
        { id: 'AC-1', statement: 'Task records stable acceptance identifiers.' },
        { statement: 'Evidence links to a task and diff hash.' },
      ],
      createdAt: '2026-07-11T07:00:00.000Z',
      updatedAt: '2026-07-11T07:00:00.000Z',
    };

    expect(validate('task', validTask)).toEqual(validTask);

    expect(() =>
      validate('task', {
        ...validTask,
        acceptance: [{ id: 'unstable', statement: 'Malformed acceptance id is not auditable.' }],
      }),
    ).toThrow(/acceptance.*id/i);
  });

  it('requires evidence envelopes to link both task id and diff hash', () => {
    const validEvidence = {
      id: 'evidence-1',
      taskId: 'task-2',
      kind: 'test',
      command: 'npm test -- tests/property/schema.property.test.ts',
      exitCode: 0,
      startedAt: '2026-07-11T07:00:00.000Z',
      finishedAt: '2026-07-11T07:00:01.000Z',
      diffHash: 'a'.repeat(64),
      log: 'pass',
    };

    expect(validate('evidence', validEvidence)).toEqual(validEvidence);

    for (const missingField of ['taskId', 'diffHash'] as const) {
      const invalid = { ...validEvidence };
      delete invalid[missingField];
      expect(() => validate('evidence', invalid)).toThrow(new RegExp(missingField, 'i'));
    }
  });

  it('validates the persisted Git Flow installation result', () => {
    const task = {
      id: 'task-git-flow',
      title: 'Initialize Git Flow once',
      phase: 'intake',
      acceptance: [{ id: 'AC-1', statement: 'Persist Git Flow bootstrap status.' }],
      createdAt: '2026-07-22T07:00:00.000Z',
      updatedAt: '2026-07-22T07:00:00.000Z',
      workflowProfile: {
        version: 1,
        isolationMode: 'git_flow',
        developmentMode: 'standard',
        reviewMode: 'std',
        comet: { projectInit: 'not_requested', openStatus: 'required' },
        gitFlow: {
          strategy: 'manual', branch: 'feature/task-git-flow', baseBranch: 'develop', status: 'pending_confirmation',
          installation: { status: 'failed', command: ['apt-get', 'install', '-y', 'git-flow'], manualCommand: 'sudo apt-get install -y git-flow' },
        },
      },
    };

    expect(validate('task', task)).toEqual(task);
    expect(() => validate('task', {
      ...task,
      workflowProfile: {
        ...task.workflowProfile,
        gitFlow: { ...task.workflowProfile.gitFlow, installation: { status: 'unknown' } },
      },
    })).toThrow(/installation.*status/i);
  });

  it('accepts only governed Wiki lifecycle statuses', () => {
    const baseRecord = {
      id: 'wiki-record-1',
      statement: 'Schemas are validated before runtime writes.',
      scope: ['src/core/schema.ts'],
      kind: 'implementation-note',
      sourceRefs: ['src/core/schema.ts'],
      sourceHashes: { 'src/core/schema.ts': 'b'.repeat(64) },
      validationTaskId: 'task-2',
      evidenceIds: ['evidence-1'],
      lastVerifiedAt: '2026-07-11T07:00:00.000Z',
      createdAt: '2026-07-11T07:00:00.000Z',
      updatedAt: '2026-07-11T07:00:00.000Z',
    };

    for (const status of ['candidate', 'verified', 'stale', 'rejected'] as const) {
      expect(validate<WikiRecord>('wiki-record', { ...baseRecord, status }).status).toBe(status);
    }

    expect(() => validate('wiki-record', { ...baseRecord, status: 'draft' })).toThrow(/status/i);
  });

  it('validates review findings with all severity levels', () => {
    const baseFinding = {
      id: 'finding-1',
      taskId: 'task-2',
      message: 'Review finding message',
    };

    for (const severity of ['blocking', 'major', 'minor', 'note'] as const) {
      const result = validate<{ severity: string }>('review-finding', { ...baseFinding, severity });
      expect(result.severity).toBe(severity);
    }

    expect(() => validate('review-finding', { ...baseFinding, severity: 'unknown' })).toThrow(/severity/i);
  });

  it('validates judge results requiring taskId, result, and acceptance items', () => {
    const validResult = {
      taskId: 'task-2',
      result: 'PASS',
      acceptance: [{ id: 'AC-1', result: 'PASS' }],
    };
    expect(validate('judge-result', validResult)).toEqual(validResult);

    expect(() => validate('judge-result', { ...validResult, result: 'INCONCLUSIVE' })).toThrow(/result/i);
    expect(() => validate('judge-result', { ...validResult, acceptance: [] })).toThrow(/item/);
  });

  it('validates task records with an optional acceptance matrix', () => {
    const taskWithMatrix = {
      id: 'task-3',
      title: 'Task with acceptance matrix',
      phase: 'intake',
      acceptance: [
        { id: 'AC-1', statement: 'First criterion.' },
        { id: 'AC-2', statement: 'Second criterion.' },
      ],
      acceptanceMatrix: {
        version: 1,
        rows: [
          {
            acceptanceId: 'AC-1',
            designRefs: ['docs/design.md'],
            implementationPaths: ['src/core/foo.ts'],
            testPaths: ['tests/unit/foo.test.ts'],
            evidence: [{ kind: 'test', command: 'npm test -- foo.test.ts' }],
            verificationLevel: 'unit',
          },
          {
            acceptanceId: 'AC-2',
            implementationPaths: ['src/core/bar.ts'],
            testPaths: ['tests/e2e/bar.test.ts'],
            evidence: [{ kind: 'integration', command: 'npm test -- integration' }],
            verificationLevel: 'integration',
          },
        ],
      },
      createdAt: '2026-07-16T07:00:00.000Z',
      updatedAt: '2026-07-16T07:00:00.000Z',
    };

    expect(validate('task', taskWithMatrix)).toEqual(taskWithMatrix);
  });

  it('accepts acceptance matrix with valid structure', () => {
    const taskWithMatrix = {
      id: 'task-9',
      title: 'Matrix structure task',
      phase: 'intake',
      acceptance: [{ id: 'AC-1', statement: 'Test.' }],
      acceptanceMatrix: {
        version: 1,
        rows: [
          {
            acceptanceId: 'AC-1',
            implementationPaths: ['src/foo.ts'],
            testPaths: ['tests/foo.test.ts'],
            evidence: [{ kind: 'test', command: 'npm test' }],
            verificationLevel: 'unit',
          },
        ],
      },
      createdAt: '2026-07-16T07:00:00.000Z',
      updatedAt: '2026-07-16T07:00:00.000Z',
    };

    expect(validate('task', taskWithMatrix)).toEqual(taskWithMatrix);
  });

  it('rejects acceptance matrix with empty evidence array', () => {
    const taskWithNoEvidence = {
      id: 'task-5',
      title: 'No evidence task',
      phase: 'intake',
      acceptance: [{ id: 'AC-1', statement: 'Test.' }],
      acceptanceMatrix: {
        version: 1,
        rows: [
          {
            acceptanceId: 'AC-1',
            implementationPaths: ['src/foo.ts'],
            testPaths: ['tests/foo.test.ts'],
            evidence: [],
            verificationLevel: 'unit',
          },
        ],
      },
      createdAt: '2026-07-16T07:00:00.000Z',
      updatedAt: '2026-07-16T07:00:00.000Z',
    };

    expect(() => validate('task', taskWithNoEvidence)).toThrow(/item/);
  });

  it('accepts legacy tasks without acceptance matrix', () => {
    const legacyTask = {
      id: 'task-legacy',
      title: 'Legacy task',
      phase: 'intake',
      acceptance: [{ id: 'AC-1', statement: 'Legacy criterion.' }],
      createdAt: '2026-07-16T07:00:00.000Z',
      updatedAt: '2026-07-16T07:00:00.000Z',
    };

    expect(validate('task', legacyTask)).toEqual(legacyTask);
  });

});
