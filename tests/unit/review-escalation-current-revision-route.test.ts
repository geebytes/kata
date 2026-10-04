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
});
