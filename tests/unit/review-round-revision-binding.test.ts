import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { appendReviewRound, readReviewRoundsState } from '../../src/quality/repair.js';
import { authorizeReviewRepair } from '../../src/workflow/repair-entry.js';
import { createTaskRevisionIfChanged } from '../../src/workflow/revision.js';

describe('revision-bound review rounds', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('preserves the sealed revision identity written with a review-loop round', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kata-review-round-binding-'));
    roots.push(root);
    await initLayout(root);

    await appendReviewRound(root, 'binding-task', {
      at: '2026-10-04T00:00:00.000Z',
      revisionId: 'revision-current',
      manifestHash: 'a'.repeat(64),
      blockingIds: ['F-1'],
      blockingCount: 1,
    });

    const [round] = (await readReviewRoundsState(root, 'binding-task')).rounds;
    expect(round).toMatchObject({
      revisionId: 'revision-current',
      manifestHash: 'a'.repeat(64),
      blockingIds: ['F-1'],
      blockingCount: 1,
    });
  });

  it('binds a review-repair round to the sealed revision that authorized it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kata-review-repair-binding-'));
    const taskId = 'review-round-writer';
    roots.push(root);
    await initLayout(root);
    await mkdir(join(root, '.kata', 'tasks', taskId), { recursive: true });
    await writeFile(join(root, 'subject.ts'), 'export const subject = true;\n');
    await writeFile(join(root, '.kata', 'tasks', taskId, 'task.json'), `${JSON.stringify({
      id: taskId,
      title: 'Review round writer',
      phase: 'review',
      acceptance: [{ id: 'AC-1', statement: 'x' }],
      ownedPaths: ['subject.ts'],
      createdAt: '2026-10-04T00:00:00.000Z',
      updatedAt: '2026-10-04T00:00:00.000Z',
    })}\n`);
    const sealed = await createTaskRevisionIfChanged({ root, taskId, ownedPaths: ['subject.ts'], checkIds: ['test'] });
    await writeFile(join(root, '.kata', 'tasks', taskId, 'review.json'), `${JSON.stringify({
      revisionId: sealed.revision.id,
      manifestHash: sealed.revision.manifestHash,
      status: 'pending',
      findings: [{ id: 'F-1', taskId, severity: 'blocking', message: 'must repair' }],
    })}\n`);

    await expect(authorizeReviewRepair(root, taskId)).resolves.toMatchObject({ authorized: true, repair: { reason: 'review_findings' } });

    const [round] = (await readReviewRoundsState(root, taskId)).rounds;
    expect(round).toMatchObject({ revisionId: sealed.revision.id, manifestHash: sealed.revision.manifestHash });
  });

  /**
   * **The stamp is the read the decision was made on, not a second look at the pointer.**
   *
   * An independent review measured this exposure: the entry asked `readBlockingProblems` (which reads the pointer to
   * decide `boundToCurrentRevision`) and then read the same non-atomic pointer *again* to stamp the round, so a seal
   * landing between the two produced a round naming a revision that had not authorised it while carrying the previous
   * revision's `blockingIds`/`blockingCount` — a mis-attributed measurement, and the round filter downstream trusts the
   * stamp. The window cannot be opened inside one call, so the property asserted here is the structural one that closes
   * it: the entry takes the revision from the reader's answer. Reverting to a second read leaves the ordinary case green
   * (the pointer has not moved), which is why the assertion is on the source contract rather than on a timing that no
   * test can schedule.
   */
  it("takes the round stamp from the reader's own read rather than a second look", async () => {
    const source = await readFile(new URL('../../src/workflow/repair-entry.ts', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('export async function authorizeReviewRepair'));
    expect(body).toContain('const revision = blockingRead.revision;');
    expect(body).not.toContain('const revision = await readCurrentTaskRevision(');
  });
});
