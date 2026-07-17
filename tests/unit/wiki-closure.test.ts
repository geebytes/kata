import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { ensureWikiClosure, evaluateWikiClosure, writeWikiClosure } from '../../src/wiki/closure.js';
import { writeWikiRecord } from '../../src/wiki/store.js';

describe('Wiki closure', () => {
  const roots: string[] = [];
  async function root(): Promise<string> {
    const value = await mkdtemp(join(tmpdir(), 'kata-wiki-closure-'));
    roots.push(value);
    await initLayout(value);
    await createTask({ root: value, id: 'closure-task', title: 'Closure task', acceptance: [{ id: 'AC-1', statement: 'Record knowledge closure.' }] });
    return value;
  }
  afterEach(async () => Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true }))));

  it('initializes a task with a deferred closure rather than fabricating Wiki content', async () => {
    const workspace = await root();
    await expect(ensureWikiClosure(workspace, 'closure-task')).resolves.toMatchObject({ decision: 'deferred' });
    await expect(evaluateWikiClosure(workspace, 'closure-task')).resolves.toMatchObject({ valid: false, reason: 'deferred' });
  });

  it('accepts a reasoned not-applicable conclusion', async () => {
    const workspace = await root();
    await writeWikiClosure(workspace, 'closure-task', { decision: 'not_applicable', reason: 'Pure formatting change; no durable project rule changed.' });
    await expect(evaluateWikiClosure(workspace, 'closure-task')).resolves.toMatchObject({ valid: true, decision: 'not_applicable' });
  });

  it('requires captured conclusions to reference a governed candidate', async () => {
    const workspace = await root();
    await writeWikiClosure(workspace, 'closure-task', { decision: 'captured', reason: 'A durable constraint was recorded.', candidateIds: ['missing'] });
    await expect(evaluateWikiClosure(workspace, 'closure-task')).resolves.toMatchObject({ valid: false, reason: 'candidate_missing' });
    await writeWikiRecord(workspace, {
      id: 'known-candidate', statement: 'A durable constraint.', scope: ['docs/constraint.md'], kind: 'convention', sourceRefs: ['docs/constraint.md'], sourceHashes: { 'docs/constraint.md': 'a'.repeat(64) }, validationTaskId: 'closure-task', evidenceIds: ['evidence-1'], status: 'candidate', lastVerifiedAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await writeWikiClosure(workspace, 'closure-task', { decision: 'captured', reason: 'A durable constraint was recorded.', candidateIds: ['known-candidate'] });
    await expect(evaluateWikiClosure(workspace, 'closure-task')).resolves.toMatchObject({ valid: true, decision: 'captured' });
  });
});
