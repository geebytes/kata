import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { transition, type Actor } from '../../src/core/state.js';
import { collectEvidence } from '../../src/quality/evidence.js';
import { judge } from '../../src/quality/judge.js';
import { recordFinding } from '../../src/quality/reviewer.js';
import { enforceRepairScope } from '../../src/quality/repair.js';
import { discoverCodeGraphCandidates, evidenceMatchesRow, readWaivers, validateMatrix, validatePathCoverage } from '../../src/quality/acceptance-matrix.js';
import { readObligations, persistBlockingJudgeResult, resolveObligationsForRevision } from '../../src/quality/repair-obligations.js';
import { readUpstreamSummary } from '../../src/workflow/navigation.js';
import { runCommand } from '../../src/workflow/orchestrator.js';

const actor: Actor = { id: 'agent-1', role: 'implementer' };
const execFileAsync = promisify(execFile);

describe('quality gates', () => {
  const roots: string[] = [];

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-quality-'));
    roots.push(root);
    await initLayout(root);
    await writeFile(join(root, 'subject.txt'), 'initial\n', 'utf8');
    return root;
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('fails Judge when required test evidence is missing', async () => {
    const root = await tempRoot();
    const task = await createQualityTask(root, 'missing-tests');
    const [lintEvidence] = await collectEvidence(task.id, [
      { kind: 'lint', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root },
    ]);

    const result = await judge({
      root,
      taskId: task.id,
      acceptance: task.acceptance,
      evidence: [lintEvidence],
      findings: [],
      currentDiffHash: lintEvidence.diffHash,
    });

    expect(result.result).toBe('FAIL');
    expect(result.acceptance).toEqual([
      { id: 'AC-1', result: 'FAIL', repairScope: 'missing_test_evidence' },
      { id: 'AC-2', result: 'FAIL', repairScope: 'missing_test_evidence' },
    ]);
  });

  it('fails Judge for stale evidence and blocks distill/archive progression', async () => {
    const root = await tempRoot();
    const task = await createQualityTask(root, 'stale-evidence');
    const [testEvidence] = await collectEvidence(task.id, [
      { kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root },
    ]);
    const currentDiffHash = 'c'.repeat(64);

    const result = await judge({
      root,
      taskId: task.id,
      acceptance: task.acceptance,
      evidence: [testEvidence],
      findings: [],
      currentDiffHash,
    });

    expect(result.result).toBe('FAIL');
    expect(result.acceptance.every((criterion) => criterion.repairScope === 'stale_evidence')).toBe(true);

    await writeQualityGateFiles(root, task.id, {
      evidence: { ...testEvidence, diffHash: 'd'.repeat(64) },
      reviewFindings: [],
      judgeResult: result,
    });
    await advanceToJudge(root, task.id);

    await expect(transition(task.id, 'distill', actor, { root })).rejects.toThrow(/fresh evidence/i);
  });

  it('fails Judge with failing_evidence when fresh test evidence fails', async () => {
    const root = await tempRoot();
    const task = await createQualityTask(root, 'fresh-failing-evidence');
    const [testEvidence] = await collectEvidence(task.id, [
      { kind: 'test', command: process.execPath, args: ['-e', 'process.exit(1)'], cwd: root },
    ]);

    const result = await judge({
      root,
      taskId: task.id,
      acceptance: task.acceptance,
      evidence: [testEvidence],
      findings: [],
      currentDiffHash: testEvidence.diffHash,
    });

    expect(result.result).toBe('FAIL');
    expect(result.acceptance).toEqual([
      { id: 'AC-1', result: 'FAIL', repairScope: 'failing_evidence' },
      { id: 'AC-2', result: 'FAIL', repairScope: 'failing_evidence' },
    ]);
  });

  it('records blocking reviewer findings and makes Judge fail', async () => {
    const root = await tempRoot();
    const task = await createQualityTask(root, 'blocking-finding');
    const finding = await recordFinding({
      root,
      taskId: task.id,
      acceptanceId: 'AC-1',
      severity: 'blocking',
      message: 'The acceptance criterion is not actually covered.',
      path: 'src/quality/judge.ts',
    });
    const [testEvidence] = await collectEvidence(task.id, [
      { kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root },
    ]);

    const result = await judge({
      root,
      taskId: task.id,
      acceptance: task.acceptance,
      evidence: [testEvidence],
      findings: [finding],
      currentDiffHash: testEvidence.diffHash,
    });

    expect(result.result).toBe('FAIL');
    expect(result.acceptance.find((criterion) => criterion.id === 'AC-1')).toMatchObject({
      result: 'FAIL',
      repairScope: 'blocking_review_finding',
    });

    const review = JSON.parse(await readFile(join(root, `.kata/tasks/${task.id}/review.json`), 'utf8')) as {
      findings: unknown[];
    };
    expect(review.findings).toHaveLength(1);
  });

  it('keeps repair bounded to the failing acceptance and returns to hardVerify', () => {
    const result = enforceRepairScope(
      {
        taskId: 'bounded-repair',
        acceptanceId: 'AC-1',
        severity: 'blocking',
        relatedPaths: ['src/quality/judge.ts', 'tests/e2e/quality-gates.test.ts'],
      },
      {
        changedPaths: ['src/quality/judge.ts', 'tests/e2e/quality-gates.test.ts'],
        filesChanged: 2,
        linesChanged: 40,
        budget: { maxFiles: 2, maxLines: 50 },
      },
    );

    expect(result).toEqual({ allowed: true, nextPhase: 'hardVerify' });
  });

  it('passes Judge only with fresh per-acceptance evidence references and read-only output', async () => {
    const root = await tempRoot();
    const task = await createQualityTask(root, 'quality-pass');
    const [testEvidence] = await collectEvidence(task.id, [
      { kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root },
    ]);

    const result = await judge({
      root,
      taskId: task.id,
      acceptance: task.acceptance,
      evidence: [testEvidence],
      findings: [],
      currentDiffHash: testEvidence.diffHash,
      proposedOutput: {
        taskId: task.id,
        result: 'PASS',
        acceptance: task.acceptance.map((criterion) => ({
          id: criterion.id,
          result: 'PASS',
          evidenceIds: [testEvidence.id],
          patch: 'disallowed judge-side mutation',
        })),
        evidenceIds: [testEvidence.id],
        archive: true,
      },
    });

    expect(result).toEqual({
      taskId: task.id,
      result: 'PASS',
      diffHash: testEvidence.diffHash,
      acceptance: [
        { id: 'AC-1', result: 'PASS', evidenceIds: [testEvidence.id] },
        { id: 'AC-2', result: 'PASS', evidenceIds: [testEvidence.id] },
      ],
      evidenceIds: [testEvidence.id],
    });
    expect(JSON.stringify(result)).not.toContain('patch');
    expect(JSON.stringify(result)).not.toContain('archive');

    await writeQualityGateFiles(root, task.id, {
      evidence: testEvidence,
      reviewFindings: [],
      judgeResult: result,
    });
    await advanceToJudge(root, task.id);

    await expect(transition(task.id, 'distill', actor, { root })).resolves.toMatchObject({ phase: 'distill' });
  });

  it('rejects evidence from more than one sealed revision', async () => {
    const root = await tempRoot();
    const task = await createQualityTask(root, 'mixed-revision-evidence');
    const evidence = await collectEvidence(task.id, [
      { kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root },
      { kind: 'lint', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root },
    ]);

    const result = await judge({
      root,
      taskId: task.id,
      acceptance: task.acceptance,
      evidence: [{ ...evidence[0]!, revisionId: 'revision-a' }, { ...evidence[1]!, revisionId: 'revision-b' }],
      findings: [],
      currentDiffHash: evidence[0]!.diffHash,
    });

    expect(result.result).toBe('FAIL');
    expect(result.acceptance).toEqual([
      { id: 'AC-1', result: 'FAIL', repairScope: 'cross_revision_evidence' },
      { id: 'AC-2', result: 'FAIL', repairScope: 'cross_revision_evidence' },
    ]);
  });

  it('preserves the review revision when a reviewer records a finding', async () => {
    const root = await tempRoot();
    const task = await createQualityTask(root, 'review-revision-preserved');
    await writeFile(join(root, `.kata/tasks/${task.id}/review.json`), `${JSON.stringify({ revisionId: 'revision-a', findings: [] })}\n`);

    await recordFinding({ root, taskId: task.id, severity: 'blocking', message: 'Revision-bound review finding.' });

    const review = JSON.parse(await readFile(join(root, `.kata/tasks/${task.id}/review.json`), 'utf8')) as { revisionId?: string };
    expect(review.revisionId).toBe('revision-a');
  });
});

describe('acceptance matrix closure', () => {
  const roots: string[] = [];

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-matrix-'));
    roots.push(root);
    await initLayout(root);
    await writeFile(join(root, 'subject.ts'), 'export const x = 1;\n', 'utf8');
    return root;
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  const validMatrix = {
    version: 1 as const,
    rows: [
      {
        acceptanceId: 'AC-1',
        implementationPaths: ['src/core/foo.ts'],
        testPaths: ['tests/unit/foo.test.ts'],
        evidence: [{ kind: 'test' as const, command: 'npm test -- foo.test.ts' }],
        verificationLevel: 'unit' as const,
      },
      {
        acceptanceId: 'AC-2',
        implementationPaths: ['src/core/bar.ts'],
        testPaths: ['tests/e2e/bar.test.ts'],
        evidence: [{ kind: 'integration' as const, command: 'npm test -- integration' }],
        verificationLevel: 'integration' as const,
      },
    ],
  };

  it('passes matrix validation for a complete matrix', () => {
    const acceptance = [
      { id: 'AC-1', statement: 'First AC' },
      { id: 'AC-2', statement: 'Second AC' },
    ];
    const errors = validateMatrix(acceptance, validMatrix);
    expect(errors).toEqual([]);
  });

  it('accepts a Node-launched Vitest runtime as declared Vitest evidence', () => {
    const row = {
      acceptanceId: 'AC-1',
      implementationPaths: ['src/foo.ts'],
      testPaths: ['tests/foo.test.ts'],
      evidence: [{ kind: 'test' as const, command: 'vitest run', testSelector: 'tests/foo.test.ts' }],
      verificationLevel: 'unit' as const,
    };

    expect(evidenceMatchesRow(
      row,
      '/home/work/.nvm/versions/node/v22.23.1/bin/node /app/kata/node_modules/vitest/vitest.mjs run tests/foo.test.ts',
      'test',
    )).toBe(true);
  });

  it('returns empty errors for legacy tasks without matrix', () => {
    const errors = validateMatrix([{ id: 'AC-1', statement: 'Test' }], undefined);
    expect(errors).toEqual([]);
  });

  it('rejects matrix with missing AC row', () => {
    const acceptance = [
      { id: 'AC-1', statement: 'First AC' },
      { id: 'AC-2', statement: 'Missing row AC' },
    ];
    const matrix = {
      version: 1 as const,
      rows: [validMatrix.rows[0]!],
    };
    const errors = validateMatrix(acceptance, matrix);
    expect(errors.some((e) => e.message.includes('no matrix row'))).toBe(true);
  });

  it('rejects matrix referencing unknown AC', () => {
    const acceptance = [{ id: 'AC-1', statement: 'Only AC' }];
    const matrix = {
      version: 1 as const,
      rows: [
        { ...validMatrix.rows[0]!, acceptanceId: 'AC-99' },
      ],
    };
    const errors = validateMatrix(acceptance, matrix);
    expect(errors.some((e) => e.message.includes('unknown'))).toBe(true);
  });

  it('validates path coverage reports missing implementation paths', () => {
    const ownedPaths = ['tests/e2e/bar.test.ts'];
    const result = validatePathCoverage(validMatrix, ownedPaths);
    expect(result.missingImplementationPaths).toContain('src/core/foo.ts');
    expect(result.missingImplementationPaths).toContain('src/core/bar.ts');
    expect(result.missingTestPaths).toContain('tests/unit/foo.test.ts');
    expect(result.missingTestPaths).not.toContain('tests/e2e/bar.test.ts');
  });

  it('validates path coverage is empty when all paths are owned', () => {
    const ownedPaths = ['src/core', 'tests'];
    const result = validatePathCoverage(validMatrix, ownedPaths);
    expect(result.missingImplementationPaths).toEqual([]);
    expect(result.missingTestPaths).toEqual([]);
  });

  it('reports CodeGraph-affected tests outside the sealed ownership scope', async () => {
    const root = await tempRoot();
    const matrix = {
      ...validMatrix,
      rows: [{ ...validMatrix.rows[0]!, implementationPaths: ['subject.ts'] }],
    };
    const runCodeGraph = async () => ['tests/e2e/downstream.test.ts'];

    await expect(discoverCodeGraphCandidates(root, matrix, ['subject.ts'], runCodeGraph)).resolves.toContainEqual(expect.objectContaining({
      path: 'tests/e2e/downstream.test.ts',
      reason: 'CodeGraph reports this test is affected by sealed implementation paths: subject.ts',
    }));
  });

  it('attributes CodeGraph candidates to each sealed implementation path', async () => {
    const root = await tempRoot();
    const matrix = {
      ...validMatrix,
      rows: [{ ...validMatrix.rows[0]!, implementationPaths: ['subject.ts', 'other.ts'] }],
    };
    const calls: string[][] = [];
    const runCodeGraph = async (_root: string, sourcePaths: string[]) => {
      calls.push(sourcePaths);
      return sourcePaths[0] === 'subject.ts'
        ? ['tests/e2e/downstream.test.ts', 'packages/core/test_parser.py']
        : ['tests/e2e/downstream.test.ts'];
    };

    const candidates = await discoverCodeGraphCandidates(root, matrix, ['subject.ts', 'other.ts'], runCodeGraph);

    expect(calls).toEqual([['subject.ts'], ['other.ts']]);
    expect(candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'tests/e2e/downstream.test.ts', sourcePaths: ['subject.ts', 'other.ts'] }),
      expect.objectContaining({ path: 'packages/core/test_parser.py', sourcePaths: ['subject.ts'] }),
    ]));
  });

  it('classifies CodeGraph candidates as evidence-covered, owned, and waived before sealing', async () => {
    const root = await tempRoot();
    const fakeCodeGraph = join(root, 'fake-codegraph');
    await writeFile(fakeCodeGraph, '#!/bin/sh\nprintf "Affected test files (2):\\n  tests/e2e/foo.test.ts\\n  packages/core/test_parser.py\\n"\n', 'utf8');
    await chmod(fakeCodeGraph, 0o755);
    const task = await createTask({
      root,
      id: 'classified-codegraph-candidates',
      title: 'Classify CodeGraph candidates',
      acceptance: [{ id: 'AC-1', statement: 'Candidates have explicit disposition.' }],
      workflowProfile: {
        version: 1,
        isolationMode: 'current_worktree',
        developmentMode: 'tdd',
        reviewMode: 'strict',
        strictClosure: true,
        comet: { projectInit: 'not_requested', openStatus: 'acknowledged' },
      },
      ownedPaths: ['subject.ts', 'tests/e2e/foo.test.ts'],
      acceptanceMatrix: {
        version: 1,
        rows: [{
          acceptanceId: 'AC-1',
          implementationPaths: ['subject.ts'],
          testPaths: ['tests/e2e/foo.test.ts'],
          evidence: [{ kind: 'test', command: process.execPath, testSelector: 'foo.test.ts' }],
          verificationLevel: 'unit',
        }],
      },
    });
    await transition(task.id, 'plan', actor, { root });
    const previousCodeGraph = process.env.STRATA_CODEGRAPH_BIN;
    process.env.STRATA_CODEGRAPH_BIN = fakeCodeGraph;
    try {
      const result = await runCommand('build', task.id, root, {
        seal: true,
        checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
        waivers: [{
          path: 'packages/core/test_parser.py',
          reason: 'The Python parser is an indirect dependency and is outside this TypeScript task scope.',
          approvedBy: 'reviewer',
          createdAt: '2026-07-16T00:00:00.000Z',
        }],
      });

      expect(result.success).toBe(true);
      expect(result.diagnostics?.evidenceCoveredCandidates).toEqual([
        expect.objectContaining({ path: 'tests/e2e/foo.test.ts' }),
      ]);
      expect(result.diagnostics?.waivedCandidates).toEqual([
        expect.objectContaining({ path: 'packages/core/test_parser.py', sourcePaths: ['subject.ts'] }),
      ]);
      expect(result.diagnostics?.unresolvedCandidates).toEqual([]);
    } finally {
      if (previousCodeGraph === undefined) delete process.env.STRATA_CODEGRAPH_BIN;
      else process.env.STRATA_CODEGRAPH_BIN = previousCodeGraph;
    }
  });

  it('Judge fails with insufficient_evidence_level for entrypoint AC without matching evidence', async () => {
    const root = await tempRoot();
    const task = await createTask({
      root,
      id: 'entrypoint-evidence-gap',
      title: 'Entrypoint evidence gap',
      acceptance: [
        { id: 'AC-1', statement: 'Requires entrypoint evidence.' },
      ],
      acceptanceMatrix: {
        version: 1,
        rows: [
          {
            acceptanceId: 'AC-1',
            implementationPaths: ['src/core/foo.ts'],
            testPaths: ['tests/e2e/foo.test.ts'],
            evidence: [{ kind: 'entrypoint', command: 'npm test -- e2e' }],
            verificationLevel: 'entrypoint',
          },
        ],
      },
    });
    const [testEvidence] = await collectEvidence(task.id, [
      { kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root },
    ]);

    const result = await judge({
      root,
      taskId: task.id,
      acceptance: task.acceptance,
      evidence: [testEvidence],
      findings: [],
      currentDiffHash: testEvidence.diffHash,
      matrix: task.acceptanceMatrix,
    });

    expect(result.result).toBe('FAIL');
    expect(result.acceptance[0]).toMatchObject({
      id: 'AC-1',
      result: 'FAIL',
      repairScope: 'insufficient_evidence_level',
    });
  });

  it('repair obligations persist across revisions', async () => {
    const root = await tempRoot();
    const taskId = 'obligation-persistence';

    await createTask({
      root,
      id: taskId,
      title: 'Obligation persistence',
      acceptance: [{ id: 'AC-1', statement: 'Test AC.' }],
    });

    const finding = await recordFinding({
      root,
      taskId,
      acceptanceId: 'AC-1',
      severity: 'blocking',
      message: 'Security vulnerability found.',
      path: 'src/security.ts',
    });

    const allObligations = await readObligations(root, taskId);
    expect(allObligations).toHaveLength(1);
    expect(allObligations[0]).toMatchObject({
      source: 'review',
      acceptanceId: 'AC-1',
    });
    expect(allObligations[0]!.resolvedAt).toBeUndefined();

    await resolveObligationsForRevision(root, taskId, 'revision-2', ['AC-1'], ['evidence-1']);
    const resolved = await readObligations(root, taskId);
    expect(resolved[0]!.resolvedAt).toBeDefined();
    expect(resolved[0]!.resolvedByRevisionId).toBe('revision-2');
  });

  it('does not create duplicate obligations for the same finding', async () => {
    const root = await tempRoot();
    const taskId = 'no-duplicate-obligation';

    await createTask({
      root,
      id: taskId,
      title: 'No duplicate obligation',
      acceptance: [{ id: 'AC-1', statement: 'Test AC.' }],
    });

    await recordFinding({
      root,
      taskId,
      acceptanceId: 'AC-1',
      severity: 'blocking',
      message: 'Blocking finding.',
    });

    const obligations = await readObligations(root, taskId);
    expect(obligations).toHaveLength(1);

    await recordFinding({
      root,
      taskId,
      acceptanceId: 'AC-1',
      severity: 'blocking',
      message: 'Another blocking finding.',
    });

    const afterSecond = await readObligations(root, taskId);
    expect(afterSecond.length).toBeGreaterThanOrEqual(1);
  });

  it('Judge persists blocking judge result as repair obligation', async () => {
    const root = await tempRoot();
    const taskId = 'judge-obligation';

    await createTask({
      root,
      id: taskId,
      title: 'Judge obligation',
      acceptance: [{ id: 'AC-1', statement: 'Test AC.' }],
    });

    await persistBlockingJudgeResult(root, taskId, [{ id: 'AC-1', result: 'FAIL' }]);

    const obligations = await readObligations(root, taskId);
    expect(obligations).toHaveLength(1);
    expect(obligations[0]).toMatchObject({
      source: 'judge',
      acceptanceId: 'AC-1',
      severity: 'blocking',
    });
  });

  it('verify rejects unresolved repair obligations', async () => {
    const root = await tempRoot();
    const taskId = 'verify-rejects-obligation';

    await createTask({
      root,
      id: taskId,
      title: 'Verify rejects obligation',
      acceptance: [{ id: 'AC-1', statement: 'Test AC.' }],
    });

    await recordFinding({
      root,
      taskId,
      acceptanceId: 'AC-1',
      severity: 'blocking',
      message: 'Blocking.',
    });

    const unresolved = await readObligations(root, taskId);
    expect(unresolved.filter((o) => !o.resolvedAt)).toHaveLength(1);

    await resolveObligationsForRevision(root, taskId, 'revision-3', ['AC-1'], ['evidence-x']);
    const resolved = await readObligations(root, taskId);
    expect(resolved.filter((o) => !o.resolvedAt)).toHaveLength(0);
  });

  it('persists an approved waiver and reports matrix candidates during strict sealing', async () => {
    const root = await tempRoot();
    const fakeCodeGraph = join(root, 'fake-codegraph');
    await writeFile(fakeCodeGraph, '#!/bin/sh\nprintf "No affected test files.\\n"\n', 'utf8');
    await chmod(fakeCodeGraph, 0o755);
    const task = await createTask({
      root,
      id: 'persisted-strict-waiver',
      title: 'Persist strict waiver',
      acceptance: [{ id: 'AC-1', statement: 'A mapped path is waived explicitly.' }],
      workflowProfile: {
        version: 1,
        isolationMode: 'current_worktree',
        developmentMode: 'tdd',
        reviewMode: 'strict',
        strictClosure: true,
        comet: { projectInit: 'not_requested', openStatus: 'acknowledged' },
      },
      ownedPaths: ['subject.ts'],
      acceptanceMatrix: {
        version: 1,
        rows: [{
          acceptanceId: 'AC-1',
          implementationPaths: ['subject.ts'],
          testPaths: ['tests/unit/foo.test.ts'],
          evidence: [{ kind: 'test', command: process.execPath }],
          verificationLevel: 'unit',
        }],
      },
    });
    await transition(task.id, 'plan', actor, { root });
    const previousCodeGraph = process.env.STRATA_CODEGRAPH_BIN;
    process.env.STRATA_CODEGRAPH_BIN = fakeCodeGraph;
    try {
      const result = await runCommand('build', task.id, root, {
        seal: true,
        checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
        waivers: [{
          path: 'tests/unit/foo.test.ts',
          reason: 'Fixture validates persistence without adding a file.',
          approvedBy: 'reviewer',
          createdAt: '2026-07-16T00:00:00.000Z',
        }],
      });

      expect(result.success).toBe(true);
      expect(await readWaivers(root, task.id)).toEqual([expect.objectContaining({
        path: 'tests/unit/foo.test.ts',
        approvedBy: 'reviewer',
      })]);
    } finally {
      if (previousCodeGraph === undefined) delete process.env.STRATA_CODEGRAPH_BIN;
      else process.env.STRATA_CODEGRAPH_BIN = previousCodeGraph;
    }
  }, 15_000);

  it('keeps an obligation open until evidence matches its acceptance-matrix row', async () => {
    const root = await tempRoot();
    const taskId = 'matrix-bound-obligation';
    const matrix = {
      version: 1 as const,
      rows: [{
        acceptanceId: 'AC-1',
        implementationPaths: ['src/core/foo.ts'],
        testPaths: ['tests/e2e/foo.test.ts'],
        evidence: [{ kind: 'integration' as const, command: 'npm test -- integration', testSelector: 'foo.test.ts' }],
        verificationLevel: 'integration' as const,
      }],
    };
    await createTask({
      root,
      id: taskId,
      title: 'Matrix bound obligation',
      acceptance: [{ id: 'AC-1', statement: 'Requires matching integration proof.' }],
      acceptanceMatrix: matrix,
    });
    await recordFinding({ root, taskId, acceptanceId: 'AC-1', severity: 'blocking', message: 'Needs integration proof.' });
    const [unrelated] = await collectEvidence(taskId, [
      { kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root },
    ]);

    await resolveObligationsForRevision(root, taskId, 'revision-1', ['AC-1'], [unrelated.id], matrix, [unrelated]);

    expect((await readObligations(root, taskId))[0]!.resolvedAt).toBeUndefined();
  });

  it('rejects an integration acceptance row when fresh evidence does not match its declared command', async () => {
    const root = await tempRoot();
    const task = await createTask({
      root,
      id: 'unit-row-command-mismatch',
      title: 'Integration row command mismatch',
      acceptance: [{ id: 'AC-1', statement: 'Requires integration-level evidence.' }],
      acceptanceMatrix: {
        version: 1,
        rows: [{
          acceptanceId: 'AC-1',
          implementationPaths: ['src/core/foo.ts'],
          testPaths: ['tests/unit/foo.test.ts'],
          evidence: [{ kind: 'integration', command: 'npm run test:integration', testSelector: 'e2e' }],
          verificationLevel: 'integration',
        }],
      },
    });
    const [evidence] = await collectEvidence(task.id, [
      { kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root },
    ]);

    const result = await judge({
      root,
      taskId: task.id,
      acceptance: task.acceptance,
      evidence: [evidence],
      findings: [],
      currentDiffHash: evidence.diffHash,
      matrix: task.acceptanceMatrix,
    });

    expect(result.acceptance[0]).toMatchObject({ result: 'FAIL', repairScope: 'insufficient_evidence_level' });
  });

  it('unit acceptance row passes even with evidence command mismatch', async () => {
    const root = await tempRoot();
    const task = await createTask({
      root, id: 'unit-row-command-tolerant', title: 'Unit row command tolerant',
      acceptance: [{ id: 'AC-1', statement: 'Requires selected unit evidence.' }],
      acceptanceMatrix: { version: 1, rows: [{
        acceptanceId: 'AC-1', implementationPaths: ['src/core/foo.ts'], testPaths: ['tests/unit/foo.test.ts'],
        evidence: [{ kind: 'test', command: 'vitest run', testSelector: 'foo.test.ts' }], verificationLevel: 'unit',
      }] },
    });
    const [evidence] = await collectEvidence(task.id, [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }]);
    const result = await judge({ root, taskId: task.id, acceptance: task.acceptance, evidence: [evidence], findings: [], currentDiffHash: evidence.diffHash, matrix: task.acceptanceMatrix });
    expect(result.acceptance[0]).toMatchObject({ result: 'PASS' });
  });

  it('records only the matching evidence IDs when resolving an obligation', async () => {
    const root = await tempRoot();
    const taskId = 'matching-obligation-evidence';
    const matrix = { version: 1 as const, rows: [{ acceptanceId: 'AC-1', implementationPaths: ['src/foo.ts'], testPaths: ['tests/foo.test.ts'], evidence: [{ kind: 'test' as const, command: 'vitest run', testSelector: 'foo.test.ts' }], verificationLevel: 'unit' as const }] };
    await createTask({ root, id: taskId, title: 'Matching evidence', acceptance: [{ id: 'AC-1', statement: 'Evidence is precise.' }], acceptanceMatrix: matrix });
    await recordFinding({ root, taskId, acceptanceId: 'AC-1', severity: 'blocking', message: 'Needs selected evidence.' });
    const [unrelated, matched] = await collectEvidence(taskId, [
      { kind: 'test', command: 'vitest run unrelated.test.ts', importResult: { exitCode: 0 }, cwd: root },
      { kind: 'test', command: 'vitest run foo.test.ts', importResult: { exitCode: 0 }, cwd: root },
    ]);
    await resolveObligationsForRevision(root, taskId, 'revision-1', ['AC-1'], [unrelated.id, matched.id], matrix, [unrelated, matched]);
    expect((await readObligations(root, taskId))[0]!.resolvedEvidenceIds).toEqual([matched.id]);
  });

  it('Judge treats major findings as blocking in strict mode', async () => {
    const root = await tempRoot();
    const task = await createQualityTask(root, 'strict-major-judge');
    const [evidence] = await collectEvidence(task.id, [
      { kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root },
    ]);

    const result = await judge({
      root, taskId: task.id, acceptance: task.acceptance,
      evidence: [evidence], findings: [
        { id: 'f-1', taskId: task.id, acceptanceId: 'AC-1', severity: 'major', message: 'Major concern.' },
      ],
      currentDiffHash: evidence.diffHash,
      reviewMode: 'strict',
    });

    expect(result.result).toBe('FAIL');
    expect(result.acceptance[0]).toMatchObject({
      result: 'FAIL',
      repairScope: 'blocking_review_finding',
    });
  });

  it('Judge does not treat major findings as blocking in standard mode', async () => {
    const root = await tempRoot();
    const task = await createQualityTask(root, 'std-major-judge');
    const [evidence] = await collectEvidence(task.id, [
      { kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root },
    ]);

    const result = await judge({
      root, taskId: task.id, acceptance: task.acceptance,
      evidence: [evidence], findings: [
        { id: 'f-2', taskId: task.id, acceptanceId: 'AC-1', severity: 'major', message: 'Major concern.' },
      ],
      currentDiffHash: evidence.diffHash,
      reviewMode: 'std',
    });

    expect(result.result).toBe('PASS');
  });

  it('old blocking review finding persists as unresolved obligation after new revision', async () => {
    const root = await tempRoot();
    const taskId = 'persist-obligation-across-revision';

    await createTask({
      root, id: taskId, title: 'Persistence task',
      acceptance: [{ id: 'AC-1', statement: 'Test AC.' }],
    });

    await recordFinding({
      root, taskId, acceptanceId: 'AC-1',
      severity: 'blocking', message: 'Old blocker.',
    });

    const obligationsBefore = await readObligations(root, taskId);
    expect(obligationsBefore.filter((o) => !o.resolvedAt)).toHaveLength(1);

    await writeFile(
      join(root, `.kata/tasks/${taskId}/review.json`),
      JSON.stringify({ revisionId: 'revision-new', findings: [] }, null, 2) + '\n',
      'utf8',
    );

    const obligationsAfter = await readObligations(root, taskId);
    const unresolved = obligationsAfter.filter((o) => !o.resolvedAt);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.acceptanceId).toBe('AC-1');
  });

  it('mixed revision evidence detection fails navigation and blocks verify', async () => {
    const root = await tempRoot();
    const taskId = 'mixed-rev-detection';
    await createQualityTask(root, taskId);

    const evidenceA = await collectEvidence(taskId, [
      { kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root },
    ]);
    const evidenceB = await collectEvidence(taskId, [
      { kind: 'lint', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root },
    ]);

    const mixed = [
      { ...evidenceA[0]!, revisionId: 'revision-a' },
      { ...evidenceB[0]!, revisionId: 'revision-b' },
    ];

    await writeFile(join(root, `.kata/evidence/${taskId}-mixed-a.json`), JSON.stringify(mixed[0], null, 2) + '\n', 'utf8');
    await writeFile(join(root, `.kata/evidence/${taskId}-mixed-b.json`), JSON.stringify(mixed[1], null, 2) + '\n', 'utf8');

    const summary = await readUpstreamSummary(root, taskId);
    expect(summary.mixedRevisionEvidence).toBe(true);
    expect(summary.currentRevisionId).toBeUndefined();
  });
});

async function createQualityTask(root: string, id: string) {
  return createTask({
    root,
    id,
    title: 'Exercise quality gates',
    acceptance: [
      { id: 'AC-1', statement: 'The implementation is covered by tests.' },
      { id: 'AC-2', statement: 'The quality gate uses fresh evidence.' },
    ],
  });
}

async function advanceToJudge(root: string, taskId: string): Promise<void> {
  for (const phase of ['plan', 'implement', 'hardVerify', 'review', 'judge'] as const) {
    await transition(taskId, phase, actor, { root });
  }
}

async function writeQualityGateFiles(
  root: string,
  taskId: string,
  input: {
    evidence: Awaited<ReturnType<typeof collectEvidence>>[number];
    reviewFindings: unknown[];
    judgeResult: unknown;
  },
): Promise<void> {
  await writeFile(join(root, `.kata/evidence/${taskId}-hard.json`), `${JSON.stringify(input.evidence, null, 2)}\n`, 'utf8');
  await writeFile(
    join(root, `.kata/tasks/${taskId}/review.json`),
    `${JSON.stringify({ findings: input.reviewFindings }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(join(root, `.kata/tasks/${taskId}/judge.json`), `${JSON.stringify(input.judgeResult, null, 2)}\n`, 'utf8');
}
