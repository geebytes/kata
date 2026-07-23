import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderDelegationPrompt } from '../../src/workflow/delegation-prompt.js';
import { nextActionForTask, readUpstreamSummary, statusActionPrompts, suggestCandidateAction, type UpstreamSummary } from '../../src/workflow/navigation.js';
import { writeWikiClosure } from '../../src/wiki/closure.js';
import { initLayout } from '../../src/core/layout.js';

const emptyUpstream: UpstreamSummary = {
  reviewFindings: 0,
  blockingFindings: 0,
  majorFindings: 0,
  failedAcceptance: 0,
  failedVerifyAcceptance: 0,
  repairScopes: [],
  verifyRepairScopes: [],
  evidenceFiles: [],
  failingEvidence: 0,
  unresolvedObligations: 0,
  unresolvedObligationAcIds: [],
};

describe('workflow guidance', () => {
  const roots: string[] = [];

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-nav-'));
    roots.push(root);
    await initLayout(root);
    return root;
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('tells implementers to finish TDD before sealing evidence', () => {
    const prompt = renderDelegationPrompt('guided-task', 'handoff-1', 'opencode', 'implementer');

    expect(prompt).toContain('先写聚焦的失败测试');
    expect(prompt).toContain('不要在编码前封存');
    expect(prompt).toContain('kata build --change guided-task --seal');
  });

  it('tells implementers to read bound design references before TDD', () => {
    const prompt = renderDelegationPrompt(
      'guided-task',
      'handoff-1',
      'opencode',
      'implementer',
      ['.kata/tasks/guided-task/design.md'],
    );

    expect(prompt).toContain('.kata/tasks/guided-task/design.md');
    expect(prompt).toContain('先阅读设计引用');
  });

  it('gives implementers an explicit unsealed build command before implementation', () => {
    const prompt = renderDelegationPrompt('guided-task', 'handoff-1', 'opencode', 'implementer');

    expect(prompt).toContain('/kata-build guided-task');
    expect(prompt).toContain('kata build --change guided-task');
    expect(prompt).toContain('先进入实施阶段');
  });

  it('keeps receiving handoffs platform-neutral and leaves host model selection to the receiver', () => {
    const prompt = renderDelegationPrompt('guided-task', 'handoff-1', 'opencode', 'implementer');

    expect(prompt).toContain('--platform <actual-platform>');
    expect(prompt).toContain('任意已识别平台接手');
    expect(prompt).toContain('Kata 不配置、不路由也不记录宿主模型');
    expect(prompt).not.toContain('按推荐切换');
    expect(prompt).not.toContain('记录实际使用模型即可');
  });

  it('routes stale verification evidence to evidence resealing', () => {
    const suggestion = suggestCandidateAction('hardVerify', {
      ...emptyUpstream,
      verifyResult: 'FAIL',
      failedVerifyAcceptance: 1,
      verifyRepairScopes: ['stale_evidence'],
    });
    const action = nextActionForTask('stale-task', suggestion.nextSkill, suggestion.role, suggestion.reason);

    expect(suggestion.reason).toBe('rebuild_stale_evidence');
    expect(action).toMatchObject({
      slashCommand: '/kata-build stale-task --seal',
      cliCommand: 'kata build --change stale-task --seal',
    });
  });

  it('pauses before implementation so the user can choose the execution platform or model', () => {
    const suggestion = suggestCandidateAction('plan', emptyUpstream);
    const action = nextActionForTask('implementation-choice-task', suggestion.nextSkill, suggestion.role, suggestion.reason);

    expect(suggestion).toMatchObject({
      nextSkill: '/kata-build',
      role: 'implementer',
      reason: 'choose_execution_mode',
    });
    expect(action).toMatchObject({
      requiresUserConfirmation: true,
      modelOrPlatformSwitchAllowed: true,
      trustBoundary: 'implementation_gate',
    });
    expect(action.pauseInstruction).toContain('平台无关交接包');
    expect(action.pauseInstruction).toContain('任意已识别平台');
    expect(action.pauseInstruction).not.toContain('/kata-delegate');
    expect(statusActionPrompts(suggestion).join('\n')).toContain('平台无关交接包');
  });

  it('routes passed hard verification to the review trust boundary', () => {
    const suggestion = suggestCandidateAction('hardVerify', {
      ...emptyUpstream,
      verifyResult: 'PASS',
      wikiClosureValid: true,
    });
    const action = nextActionForTask('verified-task', suggestion.nextSkill, suggestion.role, suggestion.reason);

    expect(suggestion).toMatchObject({
      nextSkill: '/kata-review',
      role: 'reviewer',
      reason: 'review_fresh_implementation',
    });
    expect(action).toMatchObject({
      slashCommand: '/kata-review verified-task',
      cliCommand: 'kata review --change verified-task',
      requiresUserConfirmation: true,
      trustBoundary: 'review_gate',
    });
  });

  it('ignores stale upstream artifacts that are not bound to the current evidence revision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kata-navigation-'));
    const taskId = 'revision-navigation';
    try {
      await mkdir(join(root, '.kata/evidence'), { recursive: true });
      await mkdir(join(root, '.kata/tasks', taskId), { recursive: true });
      await writeFile(
        join(root, '.kata/evidence', `${taskId}-hard.json`),
        `${JSON.stringify({ taskId, kind: 'test', exitCode: 0, revisionId: 'revision-new' }, null, 2)}\n`,
      );
      await writeFile(
        join(root, '.kata/tasks', taskId, 'review.json'),
        `${JSON.stringify({ revisionId: 'revision-old', findings: [{ severity: 'blocking' }] }, null, 2)}\n`,
      );
      await writeFile(
        join(root, '.kata/tasks', taskId, 'verify.json'),
        `${JSON.stringify({ result: 'FAIL', acceptance: [{ id: 'AC-1', result: 'FAIL', repairScope: 'blocking_review_finding' }] }, null, 2)}\n`,
      );
      await writeFile(
        join(root, '.kata/tasks', taskId, 'judge.json'),
        `${JSON.stringify({ revisionId: 'revision-old', result: 'FAIL', acceptance: [{ id: 'AC-1', result: 'FAIL', repairScope: 'blocking_review_finding' }] }, null, 2)}\n`,
      );
      await writeWikiClosure(root, taskId, {
        decision: 'not_applicable',
        reason: 'Fixture only checks revision-bound navigation.',
      });

      const upstream = await readUpstreamSummary(root, taskId);
      const suggestion = suggestCandidateAction('hardVerify', upstream);

      expect(upstream).toMatchObject({
        currentRevisionId: 'revision-new',
        reviewFindings: 0,
        blockingFindings: 0,
        failedAcceptance: 0,
        failedVerifyAcceptance: 0,
      });
      expect(suggestion).toMatchObject({
        nextSkill: '/kata-verify',
        reason: 'verify_fresh_implementation',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('marks an approval without review evidence invalid and keeps it out of Judge', async () => {
    const root = await tempRoot();
    const taskId = 'forged-review-approval';
    await mkdir(join(root, '.kata/evidence'), { recursive: true });
    await mkdir(join(root, '.kata/tasks', taskId), { recursive: true });
    await writeFile(join(root, '.kata/evidence', `${taskId}-hard.json`), JSON.stringify({
      taskId, kind: 'test', exitCode: 0, revisionId: 'revision-current',
    }));
    await writeFile(join(root, '.kata/tasks', taskId, 'review.json'), JSON.stringify({
      revisionId: 'revision-current', findings: [], status: 'approved',
    }));

    const upstream = await readUpstreamSummary(root, taskId);
    const suggestion = suggestCandidateAction('review', upstream);

    expect(upstream).toMatchObject({ reviewReady: false, invalidReviewApproval: true });
    expect(suggestion).toMatchObject({ nextSkill: '/kata-review', reason: 'invalid_review_approval' });
    expect(statusActionPrompts(suggestion).join('\n')).toContain('无效');
  });

  it('routes an implementation-ready task with deferred Wiki closure to governance closure', () => {
    const suggestion = suggestCandidateAction('hardVerify', {
      ...emptyUpstream,
      verifyResult: 'FAIL',
      wikiClosureValid: false,
      wikiClosureReason: 'deferred',
    });
    const action = nextActionForTask('wiki-pending-task', suggestion.nextSkill, suggestion.role, suggestion.reason);

    expect(suggestion).toMatchObject({
      nextSkill: '/kata-wiki-enrich',
      reason: 'resolve_wiki_closure',
    });
    expect(action).toMatchObject({
      slashCommand: '/kata-wiki-enrich wiki-pending-task',
      cliCommand: 'kata wiki closure --task wiki-pending-task --decision <captured|not_applicable> --reason <reason>',
    });
  });

  it('pauses for a host-platform model switch at the review trust boundary', () => {
    const action = nextActionForTask('review-task', '/kata-review', 'reviewer', 'review_fresh_implementation');

    expect(action).toMatchObject({
      requiresUserConfirmation: true,
      trustBoundary: 'review_gate',
    });
    expect(action.pauseInstruction).toContain('Kata 不能切换宿主平台模型');
    expect(action.pauseInstruction).toContain('--confirm-host-model');
  });

  it('prioritizes unresolved obligations over blocking review findings in navigation', () => {
    const upstream: UpstreamSummary = {
      ...emptyUpstream,
      blockingFindings: 5,
      unresolvedObligations: 1,
      unresolvedObligationAcIds: ['AC-1'],
    };
    const suggestion = suggestCandidateAction('review', upstream);

    expect(suggestion).toMatchObject({
      nextSkill: '/kata-build',
      reason: 'repair_unresolved_obligations',
    });
    expect(suggestion.priority).toBeGreaterThan(1000);
  });

  it('navigation prompt for unresolved obligations explains matrix-linked evidence', () => {
    const prompts = statusActionPrompts({
      nextSkill: '/kata-build',
      reason: 'repair_unresolved_obligations',
      role: 'implementer',
    });

    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts[0]).toContain('修复义务');
    expect(prompts[0]).toContain('矩阵关联');
  });

  it('routes a legacy obligation without an acceptance matrix to design migration', () => {
    const suggestion = suggestCandidateAction('hardVerify', {
      ...emptyUpstream,
      unresolvedObligations: 1,
      unresolvedObligationAcIds: ['AC-5'],
      missingAcceptanceMatrix: true,
    });

    expect(suggestion).toMatchObject({
      nextSkill: '/kata-design',
      role: 'designer',
      reason: 'migrate_legacy_acceptance_matrix',
    });
    expect(statusActionPrompts(suggestion).join('\n')).toContain('AC-5');
    expect(statusActionPrompts(suggestion).join('\n')).toContain('不是完成');
  });

  it('keeps matrix-backed obligations on the Build repair route', () => {
    const suggestion = suggestCandidateAction('hardVerify', {
      ...emptyUpstream,
      unresolvedObligations: 1,
      unresolvedObligationAcIds: ['AC-5'],
      missingAcceptanceMatrix: false,
    });

    expect(suggestion).toMatchObject({
      nextSkill: '/kata-build',
      role: 'implementer',
      reason: 'repair_unresolved_obligations',
    });
  });

  it('status summary includes unresolved obligation count and AC ids', async () => {
    const root = await tempRoot();
    await mkdir(join(root, '.kata/tasks', 'obligation-task'), { recursive: true });
    await writeFile(join(root, '.kata/tasks', 'obligation-task', 'task.json'), JSON.stringify({
      id: 'obligation-task', title: 'Test', phase: 'implement',
      acceptance: [{ id: 'AC-1', statement: 'Test.' }],
      createdAt: '2026-07-16T00:00:00.000Z', updatedAt: '2026-07-16T00:00:00.000Z',
    }, null, 2) + '\n', 'utf8');
    await writeFile(join(root, '.kata/tasks', 'obligation-task', 'repair-obligations.json'), JSON.stringify({
      obligations: [{
        id: 'obligation-1', taskId: 'obligation-task', source: 'review',
        acceptanceId: 'AC-1', severity: 'blocking',
        message: 'Test obligation.', createdAt: '2026-07-16T00:00:00.000Z',
      }],
      updatedAt: '2026-07-16T00:00:00.000Z',
    }, null, 2) + '\n', 'utf8');

    const summary = await readUpstreamSummary(root, 'obligation-task');

    expect(summary.unresolvedObligations).toBe(1);
    expect(summary.unresolvedObligationAcIds).toEqual(['AC-1']);
    expect(summary.blockingFindings).toBe(0);
    expect(summary.missingAcceptanceMatrix).toBe(true);
  });

  it('routes mixed revision evidence to /kata-build reseal', () => {
    const upstream: UpstreamSummary = {
      ...emptyUpstream,
      mixedRevisionEvidence: true,
    };
    const suggestion = suggestCandidateAction('hardVerify', upstream);

    expect(suggestion).toMatchObject({
      nextSkill: '/kata-build',
      reason: 'repair_mixed_revision_evidence',
    });
    expect(suggestion.priority).toBeGreaterThan(2000);
  });

  it('mixed revision evidence prompt tells user to reseal', () => {
    const prompts = statusActionPrompts({
      nextSkill: '/kata-build',
      reason: 'repair_mixed_revision_evidence',
      role: 'implementer',
    });

    expect(prompts[0]).toContain('混合 revision');
    expect(prompts[0]).toContain('--seal');
  });

  it('strict review mode routes major findings to /kata-build instead of Judge', () => {
    const upstream: UpstreamSummary = {
      ...emptyUpstream,
      reviewMode: 'strict',
      majorFindings: 2,
      blockingFindings: 0,
    };
    const suggestion = suggestCandidateAction('review', upstream);

    expect(suggestion).toMatchObject({
      nextSkill: '/kata-build',
      reason: 'repair_strict_major_findings',
    });
    expect(suggestion.priority).toBeGreaterThan(950);
  });

  it('standard review mode does not route major findings to Build', () => {
    const upstream: UpstreamSummary = {
      ...emptyUpstream,
      reviewMode: 'std',
      reviewReady: true,
      majorFindings: 2,
      blockingFindings: 0,
    };
    const suggestion = suggestCandidateAction('review', upstream);

    expect(suggestion.reason).not.toBe('repair_strict_major_findings');
    // Should route to Judge in standard mode
    expect(suggestion.reason).toBe('judge_reviewed_change');
  });
});
