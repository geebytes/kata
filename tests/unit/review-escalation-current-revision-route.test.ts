import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { reviewRoundsPath } from '../../src/quality/repair.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';
import { readUpstreamSummary, suggestCandidateAction } from '../../src/workflow/navigation.js';

const taskId = 'current-revision-route';

describe('current revision review routing', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('offers fresh review instead of escalation when only legacy or prior-revision rounds exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kata-review-route-'));
    roots.push(root);
    await initLayout(root);
    await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
    await writeFile(join(root, 'subject.ts'), 'export const subject = true;\n');
    await writeFile(join(root, '.kata', 'tasks', taskId, 'task.json'), `${JSON.stringify({
      id: taskId,
      title: 'Current review route',
      acceptance: [{ id: 'AC-1', statement: 'x' }],
      ownedPaths: ['subject.ts'],
      workflowProfile: { reviewMode: 'strict' },
    })}\n`);
    const sealed = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: ['test'] });
    await writeFile(join(root, '.kata', 'evidence', `${taskId}-current.json`), `${JSON.stringify({ taskId, kind: 'test', exitCode: 0, revisionId: sealed.revision.id })}\n`);
    await writeFile(reviewRoundsPath(root, taskId), [
      JSON.stringify({ at: '1', blockingIds: [], blockingCount: null }),
      JSON.stringify({ at: '2', revisionId: 'revision-prior', manifestHash: 'p'.repeat(64), blockingIds: [], blockingCount: null }),
      JSON.stringify({ at: '3', blockingIds: [], blockingCount: null }),
      JSON.stringify({ at: '4', revisionId: 'revision-prior', manifestHash: 'p'.repeat(64), blockingIds: [], blockingCount: null }),
    ].join('\n') + '\n');

    const summary = await readUpstreamSummary(root, taskId);

    expect(summary.currentRevisionId).toBe(sealed.revision.id);
    expect(summary.reviewEscalation).toBeUndefined();
    expect(suggestCandidateAction('review', summary).reason).not.toBe('escalate_review_without_progress');
  });

  /**
   * **A pointer that cannot be read is not a verdict about content kata could not identify.**
   *
   * `sealed` is null both when the pointer is absent and when it is unreadable, and the progress call used to be handed
   * `undefined` in both cases — which meant "judge the whole file". Reproduced before the fix: with `current-revision.json`
   * corrupted to `{`, four rounds bound to `revision-prior` produced
   * `reviewEscalation {rounds: 4, noProgressRounds: 3, blockingIds: ['F-1']}` and the route
   * `escalate_review_without_progress` — the escalation terminal (priority 2200) outranking the branch written for
   * exactly this state (`repair_unreadable_current_revision`, priority 1160).
   */
  it('does not escalate on another revision history when the sealed pointer cannot be read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kata-review-route-unreadable-'));
    roots.push(root);
    await initLayout(root);
    await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
    await writeFile(join(root, 'subject.ts'), 'export const subject = true;\n');
    await writeFile(join(root, '.kata', 'tasks', taskId, 'task.json'), `${JSON.stringify({
      id: taskId,
      title: 'Current review route',
      acceptance: [{ id: 'AC-1', statement: 'x' }],
      ownedPaths: ['subject.ts'],
      workflowProfile: { reviewMode: 'strict' },
    })}\n`);
    await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: ['test'] });
    const prior = { revisionId: 'revision-prior', manifestHash: 'p'.repeat(64), blockingIds: ['F-1'], blockingCount: 1 };
    await writeFile(reviewRoundsPath(root, taskId), [1, 2, 3, 4].map((n) => JSON.stringify({ at: String(n), ...prior })).join('\n') + '\n');
    // The pointer is damaged, not absent: the identity exists but cannot be read.
    await writeFile(join(root, '.kata', 'tasks', taskId, 'current-revision.json'), '{');

    const summary = await readUpstreamSummary(root, taskId);

    // No escalation: the rounds the escalation would have counted are not this revision's, and no revision could be named.
    expect(summary.reviewEscalation).toBeUndefined();
    expect(summary.reviewHistoryUnreadable ?? false).toBe(false);
    expect(suggestCandidateAction('review', summary).reason).toBe('repair_unreadable_current_revision');
  });

  /**
   * **A damaged line decides nothing about a revision's own history.**
   *
   * `historyHasNothingToMeasure` used to be asked as `progress.rounds === 0`, and after the revision filter that is also
   * true for a valid sealed revision whose history holds none of its own rounds plus one damaged line elsewhere — the
   * terminal then fired with `{rounds: 0, noProgressRounds: 0, blockingIds: [], unmeasurable: true}` and the sentence
   * "the recent repairs did not reduce the blocking problems". The damaged-file state is a fact about the file.
   */
  it('does not call a revision terminal when the damage is a line about something else', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kata-review-route-damaged-'));
    roots.push(root);
    await initLayout(root);
    await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
    await writeFile(join(root, 'subject.ts'), 'export const subject = true;\n');
    await writeFile(join(root, '.kata', 'tasks', taskId, 'task.json'), `${JSON.stringify({
      id: taskId,
      title: 'Current review route',
      acceptance: [{ id: 'AC-1', statement: 'x' }],
      ownedPaths: ['subject.ts'],
      workflowProfile: { reviewMode: 'strict' },
    })}\n`);
    const sealed = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: ['test'] });
    await writeFile(join(root, '.kata', 'evidence', `${taskId}-current.json`), `${JSON.stringify({ taskId, kind: 'test', exitCode: 0, revisionId: sealed.revision.id })}\n`);
    // One legacy line (nothing to measure for this revision) and one damaged line: damage is reported, no verdict issued.
    await writeFile(reviewRoundsPath(root, taskId), [
      JSON.stringify({ at: '1', blockingIds: ['F-1'], blockingCount: 2 }),
      'not-json',
    ].join('\n') + '\n');

    const summary = await readUpstreamSummary(root, taskId);

    expect(summary.reviewHistoryUnreadable).toBe(true);
    expect(summary.reviewEscalation?.unmeasurable ?? false).toBe(false);
    expect(suggestCandidateAction('review', summary).reason).not.toBe('escalate_review_without_progress');
  });
});
