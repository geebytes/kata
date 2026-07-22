import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { transition } from '../../src/core/state.js';
import { runCommand } from '../../src/workflow/orchestrator.js';
import { readUpstreamSummary, suggestCandidateAction } from '../../src/workflow/navigation.js';
import { CometGuard } from '../../src/comet/guard.js';
import { writeWikiClosure } from '../../src/wiki/closure.js';

describe('Workflow resume and lifecycle', () => {
  const roots: string[] = [];

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-wf-'));
    roots.push(root);
    await initLayout(root);
    return root;
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
  });

  it('/kata-open creates a task in intake phase with diagnostics', async () => {
    const root = await tempRoot();
    const result = await runCommand('open', 'wf-open-test', root, {
      title: 'Open workflow test',
      acceptance: [{ id: 'AC-1', statement: 'Open creates intake task.' }],
    });

    expect(result).toMatchObject({ success: true });
    expect(result.phase).toBe('intake');
    expect(result.taskId).toBe('wf-open-test');

    const taskRaw = await readFile(join(root, '.kata/tasks/wf-open-test/task.json'), 'utf8');
    const task = JSON.parse(taskRaw);
    expect(task.title).toBe('Open workflow test');
    expect(task.acceptance).toHaveLength(1);
    expect(task.acceptance[0].id).toBe('AC-1');
  });

  it('/kata-open then /kata-design advances to plan phase', async () => {
    const root = await tempRoot();
    await runCommand('open', 'wf-design-test', root, {
      title: 'Design workflow test',
      acceptance: [{ id: 'AC-1', statement: 'Design advances to plan.' }],
    });

    const result = await runCommand('design', 'wf-design-test', root);
    expect(result.success).toBe(true);
    expect(result.phase).toBe('plan');
    expect(result.diagnostics?.workflowProfile).toMatchObject({
      comet: { openStatus: 'acknowledged' },
    });

    const stateRaw = await readFile(join(root, '.kata/tasks/wf-design-test/current-state.json'), 'utf8');
    const state = JSON.parse(stateRaw);
    expect(state.phase).toBe('plan');
    const taskRaw = await readFile(join(root, '.kata/tasks/wf-design-test/task.json'), 'utf8');
    const task = JSON.parse(taskRaw) as { workflowProfile?: { comet?: { openStatus?: string } } };
    expect(task.workflowProfile?.comet?.openStatus).toBe('acknowledged');
  });

  it('keeps an implementing legacy task in place while opening matrix migration design', async () => {
    const root = await tempRoot();
    await runCommand('open', 'wf-matrix-migration', root, {
      title: 'Matrix migration', acceptance: [{ id: 'AC-1', statement: 'Migrate matrix.' }],
    });
    await runCommand('design', 'wf-matrix-migration', root);
    await runCommand('build', 'wf-matrix-migration', root, { seal: false });

    const result = await runCommand('design', 'wf-matrix-migration', root);

    expect(result).toMatchObject({ success: true, phase: 'implement' });
    expect(result.diagnostics).toMatchObject({ migrationMode: 'acceptance_matrix' });
  });

  it('allows an unverified hardVerify task to re-enter implementation for resealing', async () => {
    const root = await tempRoot();
    await runCommand('open', 'wf-unverified-reseal', root, {
      title: 'Unverified reseal',
      acceptance: [{ id: 'AC-1', statement: 'Reseal is allowed before Verify runs.' }],
    });
    await runCommand('design', 'wf-unverified-reseal', root);
    await runCommand('build', 'wf-unverified-reseal', root, { seal: false });
    await transition('wf-unverified-reseal', 'hardVerify', { id: 'tester', role: 'implementer' }, { root });

    const result = await runCommand('build', 'wf-unverified-reseal', root, { seal: false });

    expect(result.success).toBe(true);
    expect(result.phase).toBe('implement');
  });

  it('/kata-design records designer platform for the planning actor', async () => {
    const root = await tempRoot();
    await runCommand('open', 'wf-design-platform-test', root, {
      title: 'Design platform workflow test',
      acceptance: [{ id: 'AC-1', statement: 'Design records the designer platform.' }],
    });

    const result = await runCommand('design', 'wf-design-platform-test', root, { platform: 'codex' });
    expect(result.success).toBe(true);

    const stateRaw = await readFile(join(root, '.kata/tasks/wf-design-platform-test/current-state.json'), 'utf8');
    const state = JSON.parse(stateRaw);
    expect(state.actor).toMatchObject({ role: 'designer', platform: 'codex' });
  });

  it('/kata-build advances through implement and hardVerify', async () => {
    const root = await tempRoot();
    await runCommand('open', 'wf-build-test', root, {
      title: 'Build workflow test',
      acceptance: [{ id: 'AC-1', statement: 'Build advances to hardVerify.' }],
    });
    await runCommand('design', 'wf-build-test', root);
    await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');

    const result = await runCommand('build', 'wf-build-test', root, {
      ownedPaths: ['task-owned.txt'],
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });

    expect(result.phase).toBe('hardVerify');
    expect(result.success).toBe(true);
  });

  it('/kata-build enters implementation before evidence sealing', async () => {
    const root = await tempRoot();
    await runCommand('open', 'wf-guided-build', root, {
      acceptance: [{ id: 'AC-1', statement: 'Build guides implementation before sealing.' }],
    });
    await runCommand('design', 'wf-guided-build', root);

    const result = await runCommand('build', 'wf-guided-build', root, { seal: false });

    expect(result).toMatchObject({
      phase: 'implement',
      success: true,
      diagnostics: { mode: 'implement' },
    });
    expect(result.diagnostics?.implementationPrompt).toContain('先写聚焦的失败测试');
    await expect(readFile(join(root, '.kata/evidence/wf-guided-build-hard.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('/kata-build seals one final snapshot after implementation', async () => {
    const root = await tempRoot();
    await runCommand('open', 'wf-sealed-build', root, {
      acceptance: [{ id: 'AC-1', statement: 'Build seals final evidence after implementation.' }],
    });
    await runCommand('design', 'wf-sealed-build', root);
    await runCommand('build', 'wf-sealed-build', root, { seal: false });
    await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');

    const result = await runCommand('build', 'wf-sealed-build', root, {
      seal: true,
      ownedPaths: ['task-owned.txt'],
      checks: [
        { kind: 'lint', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root },
        { kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root },
      ],
    });

    expect(result).toMatchObject({ phase: 'hardVerify', success: true });
    const evidenceFiles = (await readdir(join(root, '.kata/evidence')))
      .filter((file) => file.startsWith('wf-sealed-build-'));
    const evidence = await Promise.all(evidenceFiles.map(async (file) => JSON.parse(await readFile(join(root, '.kata/evidence', file), 'utf8')) as { diffHash: string }));
    expect(new Set(evidence.map((item) => item.diffHash)).size).toBe(1);
  });

  it('keeps current-worktree evidence fresh after an unrelated file changes', async () => {
    const root = await tempRoot();
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });
    await writeFile(join(root, 'tracked-baseline.txt'), 'clean baseline\n', 'utf8');
    execFileSync('git', ['add', '.gitignore', 'tracked-baseline.txt'], { cwd: root });
    execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd: root });
    await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');
    await runCommand('open', 'wf-scoped-freshness', root, {
      acceptance: [{ id: 'AC-1', statement: 'Scoped evidence remains fresh outside its task files.' }],
    });
    const taskPath = join(root, '.kata/tasks/wf-scoped-freshness/task.json');
    const task = JSON.parse(await readFile(taskPath, 'utf8')) as Record<string, unknown>;
    await writeFile(taskPath, `${JSON.stringify({ ...task, ownedPaths: ['task-owned.txt'] }, null, 2)}\n`);
    await runCommand('design', 'wf-scoped-freshness', root);
    await runCommand('build', 'wf-scoped-freshness', root, {
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });

    const sealed = JSON.parse(await readFile(join(root, '.kata/evidence/wf-scoped-freshness-hard.json'), 'utf8')) as {
      scope?: { paths: string[] };
    };
    expect(sealed.scope?.paths).toEqual(['task-owned.txt']);

    await writeFile(join(root, 'unrelated-task.txt'), 'another task changed this\n', 'utf8');
    const verify = await runCommand('verify', 'wf-scoped-freshness', root);

    expect(verify.diagnostics?.acceptanceResults).toEqual([
      expect.objectContaining({ id: 'AC-1', result: 'PASS' }),
    ]);
    expect(verify.diagnostics).toMatchObject({ workspaceDrift: ['unrelated-task.txt'] });
  });

  it('auto-scopes sealed evidence to implementation paths when owned paths were not declared', async () => {
    const root = await tempRoot();
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'kata@example.test'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Kata Test'], { cwd: root });
    await writeFile(join(root, 'tracked-baseline.txt'), 'clean baseline\n', 'utf8');
    execFileSync('git', ['add', '.gitignore', 'tracked-baseline.txt'], { cwd: root });
    execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd: root });
    await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');
    await runCommand('open', 'wf-auto-scoped-freshness', root, {
      acceptance: [{ id: 'AC-1', statement: 'Build infers task-owned files when sealing.' }],
    });
    await runCommand('design', 'wf-auto-scoped-freshness', root);

    const build = await runCommand('build', 'wf-auto-scoped-freshness', root, {
      ownedPaths: ['task-owned.txt'],
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });

    expect(build.diagnostics).toMatchObject({
      ownedPaths: ['task-owned.txt'],
      ownedPathsSource: 'build-option',
    });
    const sealed = JSON.parse(await readFile(join(root, '.kata/evidence/wf-auto-scoped-freshness-hard.json'), 'utf8')) as {
      revisionId?: string;
      scope?: { paths: string[] };
    };
    expect(sealed.revisionId).toMatch(/^revision-/);
    expect(sealed.scope?.paths).toEqual(['task-owned.txt']);
    const task = JSON.parse(await readFile(join(root, '.kata/tasks/wf-auto-scoped-freshness/task.json'), 'utf8')) as {
      ownedPaths?: string[];
    };
    expect(task.ownedPaths).toEqual(['task-owned.txt']);

    await writeFile(join(root, 'unrelated-task.txt'), 'another task changed this\n', 'utf8');
    const verify = await runCommand('verify', 'wf-auto-scoped-freshness', root);

    expect(verify.diagnostics?.acceptanceResults).toEqual([
      expect.objectContaining({ id: 'AC-1', result: 'PASS' }),
    ]);
    expect(verify.diagnostics).toMatchObject({ workspaceDrift: ['unrelated-task.txt'] });
  });

  it('/kata-verify ignores blocking review findings from an older revision', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');
    await runCommand('open', 'wf-old-review-ignored', root, {
      acceptance: [{ id: 'AC-1', statement: 'Old review findings cannot block a newer sealed revision.' }],
    });
    const taskPath = join(root, '.kata/tasks/wf-old-review-ignored/task.json');
    const task = JSON.parse(await readFile(taskPath, 'utf8')) as Record<string, unknown>;
    await writeFile(taskPath, `${JSON.stringify({ ...task, ownedPaths: ['task-owned.txt'] }, null, 2)}\n`);
    await runCommand('design', 'wf-old-review-ignored', root);
    await runCommand('build', 'wf-old-review-ignored', root, {
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });
    await writeFile(
      join(root, '.kata/tasks/wf-old-review-ignored/review.json'),
      `${JSON.stringify({
        revisionId: 'revision-old',
        findings: [{ severity: 'blocking', title: 'Old blocker' }],
      }, null, 2)}\n`,
      'utf8',
    );
    await writeWikiClosure(root, 'wf-old-review-ignored', {
      decision: 'not_applicable',
      reason: 'Fixture only checks revision-bound review filtering.',
    });

    const verify = await runCommand('verify', 'wf-old-review-ignored', root);

    expect(verify.success).toBe(true);
    expect(verify.diagnostics?.acceptanceResults).toEqual([
      expect.objectContaining({ id: 'AC-1', result: 'PASS' }),
    ]);
    expect(verify.diagnostics).toMatchObject({
      findingCount: 0,
      blockingFindings: 0,
      ignoredReviewFindings: 1,
      ignoredReviewRevisionId: 'revision-old',
    });
  });

  it('marks a sealed revision superseded after an owned-path mutation instead of failing ACs as stale evidence', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');
    await runCommand('open', 'wf-revision-superseded', root, {
      acceptance: [{ id: 'AC-1', statement: 'Owned changes supersede the sealed revision.' }],
    });
    const taskPath = join(root, '.kata/tasks/wf-revision-superseded/task.json');
    const task = JSON.parse(await readFile(taskPath, 'utf8')) as Record<string, unknown>;
    await writeFile(taskPath, `${JSON.stringify({ ...task, ownedPaths: ['task-owned.txt'] }, null, 2)}\n`);
    await runCommand('design', 'wf-revision-superseded', root);
    await runCommand('build', 'wf-revision-superseded', root, {
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });

    await writeFile(join(root, 'task-owned.txt'), 'changed after seal\n', 'utf8');
    const verify = await runCommand('verify', 'wf-revision-superseded', root);

    expect(verify.success).toBe(false);
    expect(verify.diagnostics).toMatchObject({ revisionStatus: 'superseded' });
    expect(verify.diagnostics?.acceptanceResults).toEqual([
      expect.objectContaining({ id: 'AC-1', result: 'FAIL', repairScope: 'revision_superseded' }),
    ]);
  });

  it('/kata-judge refuses to skip the explicit review gate after build', async () => {
    const root = await tempRoot();
    await runCommand('open', 'wf-no-skip-judge-test', root, {
      title: 'No skip judge workflow test',
      acceptance: [{ id: 'AC-1', statement: 'Judge cannot run directly after build.' }],
    });
    await runCommand('design', 'wf-no-skip-judge-test', root);
    await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');
    await runCommand('build', 'wf-no-skip-judge-test', root, {
      ownedPaths: ['task-owned.txt'],
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });

    const result = await runCommand('judge', 'wf-no-skip-judge-test', root, { platform: 'opencode' });

    expect(result).toMatchObject({
      command: 'judge',
      taskId: 'wf-no-skip-judge-test',
      phase: 'hardVerify',
      success: false,
      diagnostics: {
        requiresUserConfirmation: true,
        trustBoundary: 'judge_gate',
        nextSkill: '/kata-review',
        modelOrPlatformSwitchAllowed: true,
      },
    });
    expect(result.error).toContain('Run /kata-review first');
  });

  it('requires explicit confirmation before entering the review trust boundary', async () => {
    const root = await tempRoot();
    await runCommand('open', 'wf-review-confirmation-test', root, {
      title: 'Review confirmation workflow test',
      acceptance: [{ id: 'AC-1', statement: 'Review cannot start without confirmation.' }],
    });
    await runCommand('design', 'wf-review-confirmation-test', root);
    await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');
    await runCommand('build', 'wf-review-confirmation-test', root, {
      ownedPaths: ['task-owned.txt'],
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });

    const result = await runCommand('review', 'wf-review-confirmation-test', root);

    expect(result).toMatchObject({
      command: 'review',
      phase: 'hardVerify',
      success: false,
      diagnostics: { requiresUserConfirmation: true, trustBoundary: 'review_gate' },
    });
    expect(result.error).toContain('explicit user confirmation');
  });

  it('rejects approval that bypasses an evidence-backed review conclusion', async () => {
    const root = await tempRoot();
    await runCommand('open', 'wf-review-approval-proof', root, {
      acceptance: [{ id: 'AC-1', statement: 'Review approval requires review evidence.' }],
    });
    await runCommand('design', 'wf-review-approval-proof', root);
    await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');
    await runCommand('build', 'wf-review-approval-proof', root, {
      ownedPaths: ['task-owned.txt'],
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });

    const bypass = await runCommand('review', 'wf-review-approval-proof', root, { approve: true });

    expect(bypass.success).toBe(false);
    expect(bypass.error).toContain('review phase');

    await runCommand('review', 'wf-review-approval-proof', root, { confirmHostModel: true });
    const missingEvidence = await runCommand('review', 'wf-review-approval-proof', root, { approve: true });

    expect(missingEvidence.success).toBe(false);
    expect(missingEvidence.error).toContain('review evidence');
  });

  it('rejects approval that would reuse review findings from another revision', async () => {
    const root = await tempRoot();
    const taskId = 'wf-review-approval-revision-binding';
    await runCommand('open', taskId, root, {
      acceptance: [{ id: 'AC-1', statement: 'Review approval is revision-bound.' }],
    });
    await runCommand('design', taskId, root);
    await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');
    await runCommand('build', taskId, root, {
      ownedPaths: ['task-owned.txt'],
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });
    await runCommand('review', taskId, root, { confirmHostModel: true });
    await writeFile(
      join(root, `.kata/tasks/${taskId}/review.json`),
      `${JSON.stringify({ revisionId: 'revision-old', status: 'pending', findings: [] }, null, 2)}\n`,
      'utf8',
    );

    const result = await runCommand('review', taskId, root, {
      approve: true,
      reviewEvidence: 'This must not relabel an old review as current.',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('same sealed revision');
  });

  it('keeps a pending review at the review gate instead of recommending Judge', async () => {
    const root = await tempRoot();
    await runCommand('open', 'wf-pending-review-navigation', root, {
      acceptance: [{ id: 'AC-1', statement: 'Pending review cannot be treated as reviewed.' }],
    });
    await runCommand('design', 'wf-pending-review-navigation', root);
    await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');
    await runCommand('build', 'wf-pending-review-navigation', root, {
      ownedPaths: ['task-owned.txt'],
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });
    await runCommand('review', 'wf-pending-review-navigation', root, { confirmHostModel: true });

    const upstream = await readUpstreamSummary(root, 'wf-pending-review-navigation');
    const suggestion = suggestCandidateAction('review', upstream);

    expect(suggestion).toMatchObject({ nextSkill: '/kata-review', reason: 'complete_review_conclusion' });
  });

  it('ignores evidence whose file name shares a task-id prefix but envelope belongs to another task', async () => {
    const root = await tempRoot();
    const taskId = 'wf-evidence-prefix';
    await runCommand('open', taskId, root, {
      acceptance: [{ id: 'AC-1', statement: 'Evidence belongs to exactly one task.' }],
    });
    await runCommand('design', taskId, root);
    await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');
    await runCommand('build', taskId, root, {
      ownedPaths: ['task-owned.txt'],
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });
    const evidenceFiles = await readdir(join(root, '.kata/evidence'));
    const sourceFile = evidenceFiles.find((file) => file.startsWith(`${taskId}-`));
    const source = JSON.parse(await readFile(join(root, `.kata/evidence/${sourceFile}`), 'utf8'));
    await writeFile(
      join(root, `.kata/evidence/${taskId}-other-task-failure.json`),
      `${JSON.stringify({ ...source, id: 'foreign-evidence', taskId: `${taskId}-other-task`, exitCode: 1 }, null, 2)}\n`,
      'utf8',
    );

    const upstream = await readUpstreamSummary(root, taskId);
    const result = await runCommand('verify', taskId, root);

    expect(upstream.failingEvidence).toBe(0);
    expect(result.diagnostics).toMatchObject({ implementationReady: true, evidenceCount: 2 });
  });

  it('/kata-build discovers project-owned acceptance gate checks from local skills', async () => {
    const root = await tempRoot();
    await mkdir(join(root, '.agents/skills/project-quality'), { recursive: true });
    await writeFile(
      join(root, '.agents/skills/project-quality/SKILL.md'),
      [
        '# Project Quality',
        '',
        '## Acceptance Gate',
        '',
        '```bash',
        'make lint',
        'make typecheck',
        'make pyrightcheck',
        'make test',
        '```',
        '',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      join(root, 'Makefile'),
      [
        '.PHONY: lint typecheck pyrightcheck test',
        'lint:',
        '\t@echo lint >> checks.log',
        'typecheck:',
        '\t@echo typecheck >> checks.log',
        'pyrightcheck:',
        '\t@echo pyrightcheck >> checks.log',
        'test:',
        '\t@echo test >> checks.log',
        '',
      ].join('\n'),
      'utf8',
    );
    await runCommand('open', 'wf-project-checks-test', root, {
      title: 'Project checks workflow test',
      acceptance: [{ id: 'AC-1', statement: 'Build uses project-owned quality gates.' }],
    });
    await runCommand('design', 'wf-project-checks-test', root);
    await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');

    const result = await runCommand('build', 'wf-project-checks-test', root, { ownedPaths: ['task-owned.txt'] });

    expect(result.success).toBe(true);
    expect(result.phase).toBe('hardVerify');
    await expect(readFile(join(root, 'checks.log'), 'utf8')).resolves.toContain('pyrightcheck');
    await expect(readFile(join(root, '.kata/evidence/wf-project-checks-test-pyrightcheck.json'), 'utf8')).resolves.toContain('"name": "pyrightcheck"');
    await expect(readFile(join(root, '.kata/evidence/wf-project-checks-test-typecheck.json'), 'utf8')).resolves.toContain('"name": "typecheck"');
  });

  it('/kata-build keeps project quality gates when a task also declares matrix evidence', async () => {
    const root = await tempRoot();
    const taskId = 'wf-matrix-keeps-project-checks';
    await mkdir(join(root, '.agents/skills/project-quality'), { recursive: true });
    await writeFile(
      join(root, '.agents/skills/project-quality/SKILL.md'),
      ['# Project Quality', '', '## Acceptance Gate', '', '```bash', 'make default-check', '```', ''].join('\n'),
      'utf8',
    );
    await writeFile(
      join(root, 'Makefile'),
      ['.PHONY: default-check', 'default-check:', '\t@echo default-check >> checks.log', ''].join('\n'),
      'utf8',
    );
    await runCommand('open', taskId, root, {
      title: 'Matrix and project checks',
      acceptance: [{ id: 'AC-1', statement: 'Build runs both project and matrix checks.' }],
    });
    const taskPath = join(root, `.kata/tasks/${taskId}/task.json`);
    const task = JSON.parse(await readFile(taskPath, 'utf8')) as Record<string, unknown>;
    await writeFile(taskPath, `${JSON.stringify({
      ...task,
      acceptanceMatrix: {
        version: 1,
        rows: [{
          acceptanceId: 'AC-1',
          implementationPaths: ['subject.ts'],
          testPaths: ['subject.test.ts'],
          evidence: [{
            kind: 'test',
            command: `${process.execPath} -e process.exit(0)`,
          }],
          verificationLevel: 'unit',
        }],
      },
    }, null, 2)}\n`, 'utf8');
    await runCommand('design', taskId, root);
    await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');

    const result = await runCommand('build', taskId, root, { ownedPaths: ['task-owned.txt'] });

    expect(result).toMatchObject({ success: true, phase: 'hardVerify' });
    await expect(readFile(join(root, 'checks.log'), 'utf8')).resolves.toContain('default-check');
    await expect(readFile(join(root, `.kata/evidence/${taskId}-default-check.json`), 'utf8')).resolves.toContain('"name": "default-check"');
    const evidenceFiles = await readdir(join(root, '.kata/evidence'));
    const matrixEvidence = evidenceFiles.find((f) => f.startsWith(`${taskId}-AC-1-test-`));
    expect(matrixEvidence).toBeDefined();
  });

  it('/kata-build resumes evidence collection from an interrupted implement phase', async () => {
    const root = await tempRoot();
    const taskId = 'wf-build-resume-test';
    await runCommand('open', taskId, root, {
      title: 'Build resume test',
      acceptance: [{ id: 'AC-1', statement: 'Build resumes from implement.' }],
    });
    await runCommand('design', taskId, root);
    await transition(taskId, 'implement', { id: 'interrupted-worker', role: 'implementer' }, { root });
    await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');

    const result = await runCommand('build', taskId, root, {
      ownedPaths: ['task-owned.txt'],
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });

    expect(result.success).toBe(true);
    expect(result.phase).toBe('hardVerify');
  });

  it('/kata-build re-enters hardVerify after judge reports stale evidence', async () => {
    const root = await tempRoot();
    const taskId = 'wf-build-stale-repair-test';
    await writeFile(join(root, 'subject.ts'), 'export const version = 1;\n', 'utf8');
    await runCommand('open', taskId, root, {
      title: 'Build stale repair test',
      acceptance: [{ id: 'AC-1', statement: 'Build refreshes stale evidence after judge failure.' }],
    });
    await runCommand('design', taskId, root);
    await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');
    await runCommand('build', taskId, root, {
      ownedPaths: ['subject.ts', 'task-owned.txt'],
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });
    await writeFile(join(root, 'subject.ts'), 'export const version = 2;\n', 'utf8');

    const staleVerify = await runCommand('verify', taskId, root);
    expect(staleVerify.success).toBe(false);
    expect(staleVerify.phase).toBe('hardVerify');
    expect(staleVerify.diagnostics?.acceptanceResults).toContainEqual(
      expect.objectContaining({ id: 'AC-1', result: 'FAIL', repairScope: 'revision_superseded' }),
    );
    expect(staleVerify.diagnostics?.nextAction).toMatchObject({
      nextSkill: '/kata-build',
      reason: 'rebuild_superseded_revision',
    });

    const repairBuild = await runCommand('build', taskId, root, {
      ownedPaths: ['subject.ts', 'task-owned.txt'],
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });

    expect(repairBuild.success).toBe(true);
    expect(repairBuild.phase).toBe('hardVerify');

    const events = (await readFile(join(root, `.kata/tasks/${taskId}/state-events.jsonl`), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { from: string | null; to: string });
    expect(events).toContainEqual(expect.objectContaining({ from: 'hardVerify', to: 'implement' }));
    expect(events.at(-1)).toMatchObject({ from: 'implement', to: 'hardVerify' });
  });

  it('/kata-build re-enters hardVerify after verify routes blocking review findings to build', async () => {
    const root = await tempRoot();
    const taskId = 'wf-verify-review-repair-test';
    await runCommand('open', taskId, root, {
      title: 'Verify review repair workflow test',
      acceptance: [{ id: 'AC-1', statement: 'Build can repair blocking findings found by verify.' }],
    });
    await runCommand('design', taskId, root);
    await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');
    await runCommand('build', taskId, root, {
      ownedPaths: ['task-owned.txt', `.kata/tasks/${taskId}/review.json`],
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });
    await writeFile(
      join(root, `.kata/tasks/${taskId}/review.json`),
      `${JSON.stringify({ findings: [{ severity: 'blocking', title: 'Must repair' }] }, null, 2)}\n`,
    );
    await writeWikiClosure(root, taskId, {
      decision: 'not_applicable',
      reason: 'Fixture only checks verify-to-build repair routing.',
    });

    const failedVerify = await runCommand('verify', taskId, root);
    expect(failedVerify.success).toBe(false);
    const acceptedResults = failedVerify.diagnostics?.acceptanceResults as Array<{ id: string; result: string; repairScope: string }> | undefined;
    const acceptedResult = acceptedResults?.[0];
    expect(acceptedResult?.id).toBe('AC-1');
    expect(acceptedResult?.result).toBe('FAIL');
    expect(['blocking_review_finding', 'revision_superseded']).toContain(acceptedResult?.repairScope);

    const repairBuild = await runCommand('build', taskId, root, {
      ownedPaths: ['task-owned.txt', `.kata/tasks/${taskId}/review.json`],
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });

    expect(repairBuild.success).toBe(true);
    expect(repairBuild.phase).toBe('hardVerify');
  });

  it('/kata-build requires a changed manifest before sealing a review repair', async () => {
    const root = await tempRoot();
    const taskId = 'wf-review-repair-test';
    await runCommand('open', taskId, root, {
      title: 'Review repair workflow test',
      acceptance: [{ id: 'AC-1', statement: 'Build can repair blocking review findings.' }],
    });
    await runCommand('design', taskId, root);
    await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');
    await runCommand('build', taskId, root, {
      ownedPaths: ['task-owned.txt'],
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });
    await runCommand('review', taskId, root, { platform: 'codex', confirmHostModel: true });
    await writeFile(
      join(root, `.kata/tasks/${taskId}/review.json`),
      `${JSON.stringify({ findings: [{ severity: 'blocking', title: 'Must repair' }] }, null, 2)}\n`,
    );

    const repairBuild = await runCommand('build', taskId, root, {
      ownedPaths: ['task-owned.txt'],
      platform: 'opencode',
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });

    expect(repairBuild.success).toBe(true);
    expect(repairBuild.phase).toBe('implement');

    const state = JSON.parse(await readFile(join(root, `.kata/tasks/${taskId}/current-state.json`), 'utf8')) as {
      phase: string;
      actor: { role: string; platform?: string };
    };
    expect(state).toMatchObject({ phase: 'implement', actor: { role: 'implementer', platform: 'opencode' } });

    const repair = JSON.parse(await readFile(join(root, `.kata/tasks/${taskId}/repair.json`), 'utf8')) as {
      fromPhase: string;
      toPhase: string;
      reason: string;
    };
    expect(repair).toMatchObject({
      fromPhase: 'review',
      toPhase: 'implement',
      reason: 'review_findings',
    });

    const emptySeal = await runCommand('build', taskId, root, {
      ownedPaths: ['task-owned.txt'],
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });
    expect(emptySeal).toMatchObject({
      success: false,
      phase: 'implement',
      error: expect.stringMatching(/review repair.*changed/i),
    });

    await writeFile(join(root, 'task-owned.txt'), 'repaired implementation\n', 'utf8');
    const sealedRepair = await runCommand('build', taskId, root, {
      ownedPaths: ['task-owned.txt'],
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });
    expect(sealedRepair).toMatchObject({ success: true, phase: 'hardVerify' });

    const events = (await readFile(join(root, `.kata/tasks/${taskId}/state-events.jsonl`), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { from: string | null; to: string; actor: { role: string; platform?: string } });
    expect(events).toContainEqual(expect.objectContaining({ from: 'review', to: 'implement', actor: expect.objectContaining({ platform: 'opencode' }) }));
    expect(events.at(-1)).toMatchObject({ from: 'implement', to: 'hardVerify' });
  });

  it('/kata-build re-enters implementation from review for a strict-mode major finding', async () => {
    const root = await tempRoot();
    const taskId = 'wf-strict-major-review-repair';
    const acceptanceMatrix = {
      version: 1,
      rows: [{
        acceptanceId: 'AC-1',
        implementationPaths: ['task-owned.txt'],
        testPaths: ['task-owned.txt'],
        evidence: [{ kind: 'test', command: process.execPath, testSelector: 'task-owned.txt' }],
        verificationLevel: 'unit',
      }],
    };
    await runCommand('open', taskId, root, {
      title: 'Strict major review repair workflow test',
      acceptance: [{ id: 'AC-1', statement: 'Strict major findings require Build repair.' }],
      workflowProfile: {
        version: 1,
        isolationMode: 'current_worktree',
        developmentMode: 'tdd',
        reviewMode: 'strict',
        comet: { projectInit: 'not_requested', openStatus: 'acknowledged' },
      },
    });
    const taskPath = join(root, '.kata/tasks', taskId, 'task.json');
    const task = JSON.parse(await readFile(taskPath, 'utf8')) as Record<string, unknown>;
    await writeFile(taskPath, `${JSON.stringify({ ...task, acceptanceMatrix }, null, 2)}\n`);
    await runCommand('design', taskId, root);
    await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');
    await runCommand('build', taskId, root, {
      ownedPaths: ['task-owned.txt'],
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });
    await runCommand('review', taskId, root, { platform: 'codex', confirmHostModel: true });
    await writeFile(
      join(root, `.kata/tasks/${taskId}/review.json`),
      `${JSON.stringify({ findings: [{ severity: 'major', title: 'Must repair in strict mode' }] }, null, 2)}\n`,
    );

    const repairBuild = await runCommand('build', taskId, root, {
      ownedPaths: ['task-owned.txt'],
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });

    expect(repairBuild).toMatchObject({ success: true, phase: 'implement' });
    const repair = JSON.parse(await readFile(join(root, `.kata/tasks/${taskId}/repair.json`), 'utf8')) as {
      findings: Array<{ title?: string }>;
    };
    expect(repair.findings).toContainEqual(expect.objectContaining({ title: 'Must repair in strict mode' }));
  });

  it('/kata-build rejects a standard-mode major finding from review', async () => {
    const root = await tempRoot();
    const taskId = 'wf-standard-major-review-no-repair';
    await runCommand('open', taskId, root, {
      title: 'Standard major review workflow test',
      acceptance: [{ id: 'AC-1', statement: 'Standard major findings do not enter Build repair.' }],
      workflowProfile: {
        version: 1,
        isolationMode: 'current_worktree',
        developmentMode: 'tdd',
        reviewMode: 'std',
        comet: { projectInit: 'not_requested', openStatus: 'acknowledged' },
      },
    });
    await runCommand('design', taskId, root);
    await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');
    await runCommand('build', taskId, root, {
      ownedPaths: ['task-owned.txt'],
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });
    await runCommand('review', taskId, root, { platform: 'codex', confirmHostModel: true });
    await writeFile(
      join(root, `.kata/tasks/${taskId}/review.json`),
      `${JSON.stringify({ findings: [{ severity: 'major', title: 'Does not require standard repair' }] }, null, 2)}\n`,
    );

    await expect(runCommand('build', taskId, root)).rejects.toThrow(
      'Build cannot run from review without blocking (or strict-mode major) review findings',
    );
    const state = JSON.parse(await readFile(join(root, `.kata/tasks/${taskId}/current-state.json`), 'utf8')) as { phase: string };
    expect(state.phase).toBe('review');
  });

  it('/kata-verify checks evidence readiness without entering review or judge', async () => {
    const root = await tempRoot();
    await runCommand('open', 'wf-verify-test', root, {
      title: 'Verify workflow test',
      acceptance: [{ id: 'AC-1', statement: 'Verify passes judge.' }],
    });
    await runCommand('design', 'wf-verify-test', root);
    await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');
    await runCommand('build', 'wf-verify-test', root, {
      ownedPaths: ['task-owned.txt'],
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });
    await writeWikiClosure(root, 'wf-verify-test', { decision: 'not_applicable', reason: 'Fixture has no durable project knowledge.' });

    const result = await runCommand('verify', 'wf-verify-test', root);
    expect(result.success).toBe(true);
    expect(result.phase).toBe('hardVerify');
    expect(result.diagnostics?.verifyResult).toBe('PASS');
    expect(result.diagnostics?.nextAction).toMatchObject({
      nextSkill: '/kata-review',
      requiresUserConfirmation: true,
      modelOrPlatformSwitchAllowed: true,
      trustBoundary: 'review_gate',
    });
    await expect(readFile(join(root, '.kata/tasks/wf-verify-test/verify.json'), 'utf8')).resolves.toContain('"result": "PASS"');
  });

  it('/kata-verify routes deferred Wiki closure to governance without requesting an implementation rebuild', async () => {
    const root = await tempRoot();
    await runCommand('open', 'wf-wiki-closure-route-test', root, {
      title: 'Wiki closure routing workflow test',
      acceptance: [{ id: 'AC-1', statement: 'Verification routes governance separately from implementation repairs.' }],
    });
    await runCommand('design', 'wf-wiki-closure-route-test', root);
    await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');
    await runCommand('build', 'wf-wiki-closure-route-test', root, {
      ownedPaths: ['task-owned.txt'],
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });

    const result = await runCommand('verify', 'wf-wiki-closure-route-test', root);

    expect(result).toMatchObject({
      phase: 'hardVerify',
      success: false,
      diagnostics: {
        implementationReady: true,
        governanceReady: false,
        nextAction: {
          nextSkill: '/kata-wiki-enrich',
          reason: 'resolve_wiki_closure',
          cliCommand: 'kata wiki closure --task wf-wiki-closure-route-test --decision <captured|not_applicable> --reason <reason>',
        },
      },
    });
    expect(result.error).toContain('Implementation verification passed');
  });

  it('/kata-judge reports failure when judge transition is rejected even if judge evaluation passes', async () => {
    const root = await tempRoot();
    await runCommand('open', 'wf-judge-guard-test', root, {
      title: 'Judge guard workflow test',
      acceptance: [{ id: 'AC-1', statement: 'Judge transition failures are surfaced.' }],
    });
    await runCommand('design', 'wf-judge-guard-test', root);
    await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');
    await runCommand('build', 'wf-judge-guard-test', root, {
      ownedPaths: ['task-owned.txt'],
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });
    const guard = new CometGuard(async (action, _change, phase) => {
      if (action === 'check' && phase === 'judge') {
        return { passed: false, phase, reason: 'judge blocked' };
      }
      return { passed: true, phase };
    });

    await runCommand('review', 'wf-judge-guard-test', root, { confirmHostModel: true });
    await runCommand('review', 'wf-judge-guard-test', root, { approve: true, reviewEvidence: 'Reviewed guarded judge transition.' });
    const result = await runCommand('judge', 'wf-judge-guard-test', root, { guard, confirmHostModel: true });

    expect(result.success).toBe(false);
    expect(result.phase).toBe('review');
    expect(result.error).toContain('judge blocked');
  });

  it('/kata-archive advances to distill and archive with wiki candidate', async () => {
    const root = await tempRoot();
    await runCommand('open', 'wf-archive-test', root, {
      title: 'Archive workflow test',
      acceptance: [{ id: 'AC-1', statement: 'Archive completes the lifecycle.' }],
    });
    await runCommand('design', 'wf-archive-test', root);
    await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');
    await runCommand('build', 'wf-archive-test', root, {
      ownedPaths: ['task-owned.txt'],
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });
    await writeWikiClosure(root, 'wf-archive-test', { decision: 'not_applicable', reason: 'Fixture validates lifecycle transitions only.' });

    const verifyResult = await runCommand('verify', 'wf-archive-test', root);
    expect(verifyResult.phase).toBe('hardVerify');
    const reviewResult = await runCommand('review', 'wf-archive-test', root, { confirmHostModel: true });
    expect(reviewResult.phase).toBe('review');
    await runCommand('review', 'wf-archive-test', root, { approve: true, reviewEvidence: 'Reviewed archive lifecycle fixture.' });
    const unconfirmedJudge = await runCommand('judge', 'wf-archive-test', root);
    expect(unconfirmedJudge).toMatchObject({
      phase: 'review',
      success: false,
      diagnostics: { requiresUserConfirmation: true, trustBoundary: 'judge_gate' },
    });
    const judgeResult = await runCommand('judge', 'wf-archive-test', root, { confirmHostModel: true });
    expect(judgeResult.phase).toBe('judge');

    const diffHash = await (await import('../../src/quality/evidence.js')).computeDiffHash(root);
    const hardEvidence = JSON.parse(await readFile(join(root, '.kata/evidence/wf-archive-test-hard.json'), 'utf8')) as { id: string; revisionId?: string };
    const judgeData: Record<string, unknown> = {
      taskId: 'wf-archive-test', result: 'PASS', diffHash,
      acceptance: [{ id: 'AC-1', result: 'PASS', evidenceIds: [hardEvidence.id] }],
      evidenceIds: [hardEvidence.id],
    };
    if (hardEvidence.revisionId) judgeData.revisionId = hardEvidence.revisionId;
    await writeFile(join(root, `.kata/tasks/wf-archive-test/judge.json`),
      `${JSON.stringify(judgeData, null, 2)}\n`);

    const unconfirmedArchive = await runCommand('archive', 'wf-archive-test', root);
    expect(unconfirmedArchive).toMatchObject({
      phase: 'judge',
      success: false,
      diagnostics: { requiresUserConfirmation: true, trustBoundary: 'archive_gate' },
    });
    const archiveResult = await runCommand('archive', 'wf-archive-test', root, { confirmHostModel: true });
    expect(archiveResult.phase).toBe('archive');
    expect(archiveResult.success).toBe(true);
  });

  it('resume continues from recorded phase', async () => {
    const root = await tempRoot();
    await runCommand('open', 'wf-resume-test', root, {
      title: 'Resume workflow test',
      acceptance: [{ id: 'AC-1', statement: 'Resume continues from recorded phase.' }],
    });
    await runCommand('design', 'wf-resume-test', root);
    await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');
    await runCommand('build', 'wf-resume-test', root, {
      ownedPaths: ['task-owned.txt'],
      checks: [{ kind: 'test', command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root }],
    });

    const stateRaw = await readFile(join(root, '.kata/tasks/wf-resume-test/current-state.json'), 'utf8');
    const state = JSON.parse(stateRaw);
    expect(state.phase).toBe('hardVerify');

    const events = (await readFile(join(root, '.kata/tasks/wf-resume-test/state-events.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { to: string });
    const phases = events.map((e) => e.to);
    expect(phases).toEqual(['intake', 'plan', 'implement', 'hardVerify']);
  });

  it('explicit task id overrides active task binding in command result', async () => {
    const root = await tempRoot();
    await runCommand('open', 'active-other-task', root, {
      title: 'Active but not the requested task',
      acceptance: [{ id: 'AC-1', statement: 'This is the active task.' }],
    });
    await runCommand('open', 'explicit-requested-task', root, {
      title: 'Explicitly requested task',
      acceptance: [{ id: 'AC-1', statement: 'This one was explicitly asked for.' }],
    });

    const result = await runCommand('open', 'explicit-requested-task', root, {
      title: 'Re-open explicit',
      acceptance: [{ id: 'AC-1', statement: 'Explicit task id.' }],
    });

    expect(result.taskId).toBe('explicit-requested-task');
    expect(result.success).toBe(true);
    expect(result.command).toBe('open');
    expect(result.diagnostics?.acceptanceCount).toBe(1);

    const wrongTaskPath = join(root, '.kata/tasks/active-other-task/task.json');
    const wrongTask = JSON.parse(await readFile(wrongTaskPath, 'utf8')) as { acceptance: Array<{ statement: string }> };
    expect(wrongTask.acceptance[0].statement).toBe('This is the active task.');
  });

  it('/kata-hotfix runs full open-build-verify-archive cycle with quick checks', async () => {
    const root = await tempRoot();
    const quickCheck = { kind: 'test' as const, command: process.execPath, args: ['-e', 'process.exit(0)'], cwd: root };

    await writeFile(join(root, 'task-owned.txt'), 'sealed implementation\n', 'utf8');
    const result = await runCommand('hotfix', 'wf-hotfix-test', root, {
      title: 'Hotfix workflow test',
      acceptance: [{ id: 'AC-1', statement: 'Hotfix completes the full cycle.' }],
      ownedPaths: ['task-owned.txt'],
      checks: [quickCheck],
    });

    expect(result.phase).toBe('hardVerify');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Wiki closure');
  }, 15000);
});
