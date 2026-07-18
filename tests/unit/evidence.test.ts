import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkFreshness,
  collectEvidence,
  computeDiffHash,
  computeScopeHash,
  type EvidenceEnvelope,
} from '../../src/quality/evidence.js';
import { computeManifestHash, createTaskRevision } from '../../src/workflow/revision.js';
import { findOwnershipConflicts, workspaceDrift } from '../../src/workflow/revision.js';

describe('quality evidence collection', () => {
  const roots: string[] = [];

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-evidence-'));
    roots.push(root);
    await writeFile(join(root, 'subject.txt'), 'initial\n', 'utf8');
    return root;
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('collects bounded command evidence with exit codes, redacted logs, environment summary, and diff hash', async () => {
    const root = await tempRoot();

    const [evidence] = await collectEvidence('task-6', [
      {
        kind: 'test',
        command: process.execPath,
        args: ['-e', "console.log('token=super-secret'); process.exit(3)"],
        cwd: root,
        redact: ['super-secret'],
        timeoutMs: 2_000,
        env: { STRATA_SECRET_TOKEN: 'super-secret' },
      },
    ]);

    expect(evidence).toMatchObject({
      taskId: 'task-6',
      kind: 'test',
      command: expect.stringContaining('-e'),
      exitCode: 3,
      environment: expect.stringContaining('node='),
    });
    expect(evidence.diffHash).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.command).toContain('[REDACTED]');
    expect(evidence.command).not.toContain('super-secret');
    expect(evidence.log).toContain('token=[REDACTED]');
    expect(evidence.log).not.toContain('super-secret');
  });

  it('redacts inherited sensitive environment values from stored command strings', async () => {
    const root = await tempRoot();
    const inheritedSecretName = 'STRATA_COMMAND_SECRET_TOKEN';
    const inheritedSecretValue = 'command-inherited-super-secret';
    const previousValue = process.env[inheritedSecretName];
    process.env[inheritedSecretName] = inheritedSecretValue;

    try {
      const [evidence] = await collectEvidence('task-6-command-redaction', [
        {
          kind: 'test',
          command: process.execPath,
          args: ['-e', `console.log('${inheritedSecretValue}')`],
          cwd: root,
          timeoutMs: 2_000,
        },
      ]);

      expect(evidence.command).toContain('[REDACTED]');
      expect(evidence.command).not.toContain(inheritedSecretValue);
      expect(evidence.log).toContain('[REDACTED]');
      expect(evidence.log).not.toContain(inheritedSecretValue);
    } finally {
      if (previousValue === undefined) {
        delete process.env[inheritedSecretName];
      } else {
        process.env[inheritedSecretName] = previousValue;
      }
    }
  });

  it('redacts inherited sensitive environment values from command logs', async () => {
    const root = await tempRoot();
    const inheritedSecretName = 'STRATA_INHERITED_SECRET_TOKEN';
    const inheritedSecretValue = 'inherited-super-secret';
    const previousValue = process.env[inheritedSecretName];
    process.env[inheritedSecretName] = inheritedSecretValue;

    try {
      const [evidence] = await collectEvidence('task-6-inherited-env', [
        {
          kind: 'test',
          command: process.execPath,
          args: ['-e', `console.log(process.env.${inheritedSecretName})`],
          cwd: root,
          timeoutMs: 2_000,
        },
      ]);

      expect(evidence.log).toContain('[REDACTED]');
      expect(evidence.log).not.toContain(inheritedSecretValue);
    } finally {
      if (previousValue === undefined) {
        delete process.env[inheritedSecretName];
      } else {
        process.env[inheritedSecretName] = previousValue;
      }
    }
  });

  it('imports CI evidence without executing a local command', async () => {
    const root = await tempRoot();

    const [evidence] = await collectEvidence('task-6-ci', [
      {
        kind: 'ci',
        command: 'ci://run/123',
        cwd: root,
        importResult: {
          exitCode: 0,
          log: 'remote checks passed',
          environment: 'github-actions ubuntu-latest node=22',
        },
      },
    ]);

    expect(evidence).toMatchObject({
      taskId: 'task-6-ci',
      kind: 'ci',
      command: 'ci://run/123',
      exitCode: 0,
      log: 'remote checks passed',
      environment: 'github-actions ubuntu-latest node=22',
    });
  });

  it('records the post-check diff hash and ignores local test cache churn', async () => {
    const root = await tempRoot();
    await mkdir(join(root, '.pytest_cache'), { recursive: true });

    const [evidence] = await collectEvidence('task-cache-churn', [
      {
        kind: 'test',
        command: process.execPath,
        args: [
          '-e',
          "const fs = require('node:fs'); fs.writeFileSync('subject.txt', 'verified\\n'); fs.writeFileSync('.pytest_cache/state', String(Date.now()));",
        ],
        cwd: root,
        timeoutMs: 2_000,
      },
    ]);

    expect(checkFreshness(evidence, await computeDiffHash(root))).toEqual({ fresh: true });
  });

  it('does not stale implementation evidence when Wiki governance records change', async () => {
    const root = await tempRoot();
    const [evidence] = await collectEvidence('task-wiki-closure', [
      {
        kind: 'test',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        cwd: root,
      },
    ]);

    await mkdir(join(root, '.llmwiki'), { recursive: true });
    await writeFile(join(root, '.llmwiki', 'closure.md'), 'captured governance decision\n', 'utf8');

    expect(checkFreshness(evidence, await computeDiffHash(root))).toEqual({ fresh: true });
  });

  it('assigns one final snapshot to every check in a collection run', async () => {
    const root = await tempRoot();

    const evidence = await collectEvidence('task-final-snapshot', [
      {
        kind: 'lint',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        cwd: root,
      },
      {
        kind: 'test',
        command: process.execPath,
        args: ['-e', "require('node:fs').writeFileSync('subject.txt', 'sealed\\n')"],
        cwd: root,
      },
    ]);

    expect(new Set(evidence.map((item) => item.diffHash)).size).toBe(1);
    expect(evidence[0]?.diffHash).toBe(await computeDiffHash(root));
  });

  it('detects stale evidence when the current diff hash changes', () => {
    const evidence: EvidenceEnvelope = {
      id: 'evidence-1',
      taskId: 'task-6',
      kind: 'test',
      command: 'npm test',
      exitCode: 0,
      startedAt: '2026-07-11T00:00:00.000Z',
      finishedAt: '2026-07-11T00:00:01.000Z',
      diffHash: 'a'.repeat(64),
      log: 'pass',
    };

    expect(checkFreshness(evidence, 'a'.repeat(64))).toEqual({ fresh: true });
    expect(checkFreshness(evidence, 'b'.repeat(64))).toEqual({
      fresh: false,
      reason: 'diff_hash_mismatch',
      expectedDiffHash: 'b'.repeat(64),
      evidenceDiffHash: 'a'.repeat(64),
    });
  });

  it('keeps scoped evidence fresh when an unrelated file changes', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'task-owned.txt'), 'sealed\n', 'utf8');
    const scopePaths = ['task-owned.txt'];
    const scopeHash = await computeScopeHash(root, scopePaths);
    const evidence: EvidenceEnvelope = {
      id: 'scoped-evidence',
      taskId: 'task-scoped',
      kind: 'test',
      command: 'test',
      exitCode: 0,
      startedAt: '2026-07-14T00:00:00.000Z',
      finishedAt: '2026-07-14T00:00:01.000Z',
      diffHash: await computeDiffHash(root),
      scope: { paths: scopePaths, hash: scopeHash },
    };

    await writeFile(join(root, 'unrelated.txt'), 'other task\n', 'utf8');

    expect(checkFreshness(evidence, await computeDiffHash(root), await computeScopeHash(root, scopePaths)))
      .toEqual({ fresh: true });
  });

  it('stales scoped evidence when a task-owned file changes', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'task-owned.txt'), 'sealed\n', 'utf8');
    const scopePaths = ['task-owned.txt'];
    const evidence: EvidenceEnvelope = {
      id: 'scoped-evidence',
      taskId: 'task-scoped',
      kind: 'test',
      command: 'test',
      exitCode: 0,
      startedAt: '2026-07-14T00:00:00.000Z',
      finishedAt: '2026-07-14T00:00:01.000Z',
      diffHash: await computeDiffHash(root),
      scope: { paths: scopePaths, hash: await computeScopeHash(root, scopePaths) },
    };

    await writeFile(join(root, 'task-owned.txt'), 'changed after seal\n', 'utf8');

    expect(checkFreshness(evidence, await computeDiffHash(root), await computeScopeHash(root, scopePaths)))
      .toMatchObject({ fresh: false, reason: 'scope_hash_mismatch' });
  });

  it('keeps legacy evidence repository-scoped when no scope is recorded', async () => {
    const root = await tempRoot();
    const evidence: EvidenceEnvelope = {
      id: 'legacy-evidence',
      taskId: 'task-legacy',
      kind: 'test',
      command: 'test',
      exitCode: 0,
      startedAt: '2026-07-14T00:00:00.000Z',
      finishedAt: '2026-07-14T00:00:01.000Z',
      diffHash: await computeDiffHash(root),
    };

    await writeFile(join(root, 'unrelated.txt'), 'still stale for legacy evidence\n', 'utf8');

    expect(checkFreshness(evidence, await computeDiffHash(root))).toMatchObject({
      fresh: false,
      reason: 'diff_hash_mismatch',
    });
  });

  it('binds sealed evidence to an immutable revision manifest instead of a transient scope', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'task-owned.txt'), 'sealed\n', 'utf8');
    const revision = await createTaskRevision({ root, taskId: 'task-revision', ownedPaths: ['task-owned.txt'] });

    const [evidence] = await collectEvidence('task-revision', [
      { kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root },
    ], { revision });

    expect(evidence.revisionId).toBe(revision.id);
    expect(evidence.scope).toEqual({ paths: ['task-owned.txt'], hash: revision.manifestHash });
  });

  it('uses the same recursive hash for directory-owned revision manifests and evidence scopes', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'src/domain'), { recursive: true });
    await mkdir(join(root, 'src/domain/__pycache__'), { recursive: true });
    await writeFile(join(root, 'src/domain/a.ts'), 'export const a = 1;\n', 'utf8');
    await writeFile(join(root, 'src/domain/b.ts'), 'export const b = 2;\n', 'utf8');
    await writeFile(join(root, 'src/domain/__pycache__/a.pyc'), 'ignored cache\n', 'utf8');

    const manifestHash = await computeManifestHash(root, ['src/domain']);
    const scopeHash = await computeScopeHash(root, ['src/domain']);

    expect(manifestHash).toBe(scopeHash);
  });

  it('reports overlapping ownership claims and unowned workspace drift', async () => {
    const root = await tempRoot();
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });
    await mkdir(join(root, '.kata/tasks/other-task'), { recursive: true });
    await writeFile(join(root, '.kata/tasks/other-task/task.json'), `${JSON.stringify({ ownedPaths: ['shared.ts'] })}\n`);
    await writeFile(join(root, 'shared.ts'), 'owned\n', 'utf8');
    await writeFile(join(root, 'tracked-clean.ts'), 'clean\n', 'utf8');
    execFileSync('git', ['add', 'subject.txt', 'shared.ts', 'tracked-clean.ts'], { cwd: root });
    execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd: root });
    await writeFile(join(root, 'unowned.ts'), 'drift\n', 'utf8');

    await expect(findOwnershipConflicts(root, 'current-task', ['shared.ts'])).resolves.toEqual([
      { taskId: 'other-task', path: 'shared.ts' },
    ]);
    await expect(workspaceDrift(root, ['shared.ts'])).resolves.toEqual(['unowned.ts']);
  });

  it('ignores ownership claims from archived tasks', async () => {
    const root = await tempRoot();
    await mkdir(join(root, '.kata/tasks/archived-task'), { recursive: true });
    await writeFile(join(root, '.kata/tasks/archived-task/task.json'), `${JSON.stringify({ ownedPaths: ['shared.ts'] })}\n`);
    await writeFile(
      join(root, '.kata/tasks/archived-task/current-state.json'),
      `${JSON.stringify({ taskId: 'archived-task', phase: 'archive', actor: { id: 'tester', role: 'tester' }, updatedAt: '2026-07-14T00:00:00.000Z' })}\n`,
    );

    await expect(findOwnershipConflicts(root, 'current-task', ['shared.ts'])).resolves.toEqual([]);
  });

  it.each(['superseded_by', 'covered_by', 'duplicate_of', 'merged_into'] as const)(
    'ignores ownership claims terminally redirected through %s even when its target remains active',
    async (relationType) => {
      const root = await tempRoot();
      await mkdir(join(root, '.kata/tasks/terminal-owner'), { recursive: true });
      await mkdir(join(root, '.kata/tasks/active-target'), { recursive: true });
      await writeFile(join(root, '.kata/tasks/terminal-owner/task.json'), `${JSON.stringify({ ownedPaths: ['shared.ts'] })}\n`);
      await writeFile(
        join(root, '.kata/tasks/terminal-owner/task-relations.json'),
        `${JSON.stringify({
          taskId: 'terminal-owner',
          relations: [{ type: relationType, targetTaskId: 'active-target', createdAt: '2026-07-16T00:00:00.000Z' }],
        })}\n`,
      );
      await writeFile(join(root, '.kata/tasks/active-target/task.json'), `${JSON.stringify({ ownedPaths: [] })}\n`);
      await writeFile(
        join(root, '.kata/tasks/active-target/current-state.json'),
        `${JSON.stringify({ taskId: 'active-target', phase: 'build', actor: { id: 'tester', role: 'tester' }, updatedAt: '2026-07-16T00:00:00.000Z' })}\n`,
      );

      await expect(findOwnershipConflicts(root, 'current-task', ['shared.ts'])).resolves.toEqual([]);
    },
  );

  it('ignores ownership claims terminally merged into an archived task', async () => {
    const root = await tempRoot();
    await mkdir(join(root, '.kata/tasks/merged-task'), { recursive: true });
    await mkdir(join(root, '.kata/tasks/archived-target'), { recursive: true });
    await writeFile(join(root, '.kata/tasks/merged-task/task.json'), `${JSON.stringify({ ownedPaths: ['shared.ts'] })}\n`);
    await writeFile(
      join(root, '.kata/tasks/merged-task/current-state.json'),
      `${JSON.stringify({ taskId: 'merged-task', phase: 'hardVerify', actor: { id: 'tester', role: 'tester' }, updatedAt: '2026-07-16T00:00:00.000Z' })}\n`,
    );
    await writeFile(
      join(root, '.kata/tasks/merged-task/task-relations.json'),
      `${JSON.stringify({
        taskId: 'merged-task',
        relations: [{ type: 'merged_into', targetTaskId: 'archived-target', createdAt: '2026-07-16T00:00:00.000Z' }],
      })}\n`,
    );
    await writeFile(join(root, '.kata/tasks/archived-target/task.json'), `${JSON.stringify({ ownedPaths: ['shared.ts'] })}\n`);
    await writeFile(
      join(root, '.kata/tasks/archived-target/current-state.json'),
      `${JSON.stringify({ taskId: 'archived-target', phase: 'archive', actor: { id: 'tester', role: 'tester' }, updatedAt: '2026-07-16T00:00:00.000Z' })}\n`,
    );

    await expect(findOwnershipConflicts(root, 'current-task', ['shared.ts'])).resolves.toEqual([]);
  });
});
