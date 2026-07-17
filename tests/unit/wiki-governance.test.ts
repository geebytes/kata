import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { createTask } from '../../src/core/task.js';
import { transition } from '../../src/core/state.js';
import { computeDiffHash } from '../../src/quality/evidence.js';
import { proposeFromPassedTask } from '../../src/wiki/provenance.js';
import { verifySources, markRecordStale } from '../../src/wiki/drift.js';
import { checkConflicts } from '../../src/wiki/conflict.js';
import { promote, rejectCandidate } from '../../src/wiki/promotion.js';
import { readWikiRecords } from '../../src/wiki/store.js';
import { selectAuthoritativeContext } from '../../src/wiki/context.js';
import type { WikiRecord } from '../../src/wiki/record.js';
import type { Actor } from '../../src/core/state.js';

const actor: Actor = { id: 'agent-1', role: 'implementer' };

describe('Wiki governance', () => {
  const roots: string[] = [];

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-wiki-'));
    roots.push(root);
    await initLayout(root);
    return root;
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function writePassingGates(root: string, taskId: string): Promise<void> {
    const diffHash = await computeDiffHash(root);
    await writeFile(
      join(root, `.kata/evidence/${taskId}-hard.json`),
      `${JSON.stringify({ id: `${taskId}-hard`, taskId, kind: 'test', command: 'vitest run', exitCode: 0, startedAt: '2026-07-11T00:00:00.000Z', finishedAt: '2026-07-11T00:00:01.000Z', diffHash }, null, 2)}\n`,
    );
    await writeFile(join(root, `.kata/tasks/${taskId}/review.json`), `${JSON.stringify({ findings: [] }, null, 2)}\n`);
    await writeFile(
      join(root, `.kata/tasks/${taskId}/judge.json`),
      `${JSON.stringify({ taskId, result: 'PASS', diffHash, acceptance: [{ id: 'AC-1', result: 'PASS', evidenceIds: [`${taskId}-hard`] }], evidenceIds: [`${taskId}-hard`] }, null, 2)}\n`,
    );
  }

  describe('5.1 WikiRecord storage and schema validation', () => {
    it('stores and reads a WikiRecord with front-matter compatible fields', async () => {
      const root = await tempRoot();
      const record: WikiRecord = {
        id: 'wiki-test-1',
        statement: 'Wiki records store project understanding with provenance.',
        scope: ['src/core/context.ts'],
        kind: 'implementation-note',
        sourceRefs: ['src/core/context.ts'],
        sourceHashes: { 'src/core/context.ts': 'a'.repeat(64) },
        validationTaskId: 'task-validation',
        evidenceIds: ['evidence-1'],
        status: 'verified',
        lastVerifiedAt: '2026-07-11T00:00:00.000Z',
        createdAt: '2026-07-11T00:00:00.000Z',
        updatedAt: '2026-07-11T00:00:00.000Z',
      };

      const { writeWikiRecord } = await import('../../src/wiki/store.js');
      await writeWikiRecord(root, record);
      const records = await readWikiRecords(root);

      expect(records).toHaveLength(1);
      expect(records[0].id).toBe('wiki-test-1');
      expect(records[0].status).toBe('verified');
      expect(records[0].statement).toContain('provenance');
    });

    it('validates WikiRecord against wiki-record schema', async () => {
      const root = await tempRoot();
      const { writeWikiRecord } = await import('../../src/wiki/store.js');

      await expect(
        writeWikiRecord(root, {
          id: 'bad-record',
          statement: '',
          scope: ['test'],
          kind: '',
          sourceRefs: ['test.ts'],
          sourceHashes: {},
          validationTaskId: '',
          evidenceIds: ['e1'],
          status: 'verified' as const,
          lastVerifiedAt: '',
          createdAt: '',
          updatedAt: '',
        }),
      ).rejects.toThrow(/statement|minLength/i);
    });

    it('rejects invalid WikiRecord status', async () => {
      const root = await tempRoot();
      const { writeWikiRecord } = await import('../../src/wiki/store.js');

      await expect(
        writeWikiRecord(root, {
          id: 'bad-status',
          statement: 'Invalid status.',
          scope: ['test'],
          kind: 'test',
          sourceRefs: ['test.ts'],
          sourceHashes: {},
          validationTaskId: 'task-bad',
          evidenceIds: ['e1'],
          status: 'invalid' as WikiRecord['status'],
          lastVerifiedAt: '2026-07-11T00:00:00.000Z',
          createdAt: '2026-07-11T00:00:00.000Z',
          updatedAt: '2026-07-11T00:00:00.000Z',
        }),
      ).rejects.toThrow(/invalid|enum|candidate|verified|stale|rejected/i);
    });
  });

  describe('5.2 Candidate generation from passed tasks only', () => {
    async function createCompletedTask(root: string, id: string) {
      const task = await createTask({
        root,
        id,
        title: 'Completed task',
        acceptance: [{ id: 'AC-1', statement: 'The feature is implemented.' }],
      });
      await transition(task.id, 'plan', actor, { root });
      await transition(task.id, 'implement', actor, { root });
      await transition(task.id, 'hardVerify', actor, { root });
      await transition(task.id, 'review', actor, { root });
      await transition(task.id, 'judge', actor, { root });
      await writePassingGates(root, id);
      await transition(task.id, 'distill', actor, { root });
      return task;
    }

    it('generates Wiki candidates only from tasks that passed judge and reached distill', async () => {
      const root = await tempRoot();
      const task = await createCompletedTask(root, 'task-passed');

      const candidates = await proposeFromPassedTask(root, task.id, {
        statement: 'Completed features produce Wiki candidates.',
        scope: ['src/wiki/provenance.ts'],
        kind: 'implementation-note',
        sourceRefs: ['src/wiki/provenance.ts'],
      });

      expect(candidates).toHaveLength(1);
      expect(candidates[0].status).toBe('candidate');
      expect(candidates[0].validationTaskId).toBe(task.id);
      expect(candidates[0].evidenceIds).toHaveLength(1);
    });

    it('rejects candidate generation from tasks that have not passed judge', async () => {
      const root = await tempRoot();
      const task = await createTask({
        root,
        id: 'task-incomplete',
        title: 'Incomplete task',
        acceptance: [{ id: 'AC-1', statement: 'Incomplete feature.' }],
      });

      await expect(
        proposeFromPassedTask(root, task.id, {
          statement: 'Should not generate candidate.',
          scope: [],
          kind: 'test',
          sourceRefs: [],
        }),
      ).rejects.toThrow(/judge|PASS|distill/i);
    });

    it('marks generated candidates as non-authoritative', async () => {
      const root = await tempRoot();
      const task = await createCompletedTask(root, 'task-candidate');

      await proposeFromPassedTask(root, task.id, {
        statement: 'Candidates must not be authoritative.',
        scope: ['src/wiki/provenance.ts'],
        kind: 'implementation-note',
        sourceRefs: ['src/wiki/provenance.ts'],
      });

      const records = await readWikiRecords(root);
      expect(records).toHaveLength(1);
      expect(records[0].status).toBe('candidate');

      const ctx = await selectAuthoritativeContext(root, ['src/wiki/provenance.ts']);
      expect(ctx.authoritative).toHaveLength(0);
      expect(ctx.excluded.map((r) => r.id)).toContain(records[0].id);
    });
  });

  describe('5.3 wiki verify drift detection', () => {
    it('detects changed sources and marks affected records stale', async () => {
      const root = await tempRoot();
      await writeFile(join(root, 'source.ts'), 'original content\n', 'utf8');
      const diffHash = await computeDiffHash(root);

      const { writeWikiRecord } = await import('../../src/wiki/store.js');
      await writeWikiRecord(root, {
        id: 'wiki-drift',
        statement: 'Source referenced Wiki.',
        scope: ['source.ts'],
        kind: 'implementation-note',
        sourceRefs: ['source.ts'],
        sourceHashes: { 'source.ts': diffHash },
        validationTaskId: 'task-drift',
        evidenceIds: ['evidence-1'],
        status: 'verified',
        lastVerifiedAt: '2026-07-11T00:00:00.000Z',
        createdAt: '2026-07-11T00:00:00.000Z',
        updatedAt: '2026-07-11T00:00:00.000Z',
      });

      await writeFile(join(root, 'source.ts'), 'changed content\n', 'utf8');
      const report = await verifySources(root);

      expect(report.checked).toBeGreaterThanOrEqual(1);
      expect(report.stale.map((r) => r.id)).toContain('wiki-drift');
      expect(report.stale[0].reason).toBe('source_changed');
      expect(report.missing).toEqual([]);
    });

    it('detects missing source files and marks records stale', async () => {
      const root = await tempRoot();
      const { writeWikiRecord } = await import('../../src/wiki/store.js');
      await writeWikiRecord(root, {
        id: 'wiki-missing',
        statement: 'Missing source referenced Wiki.',
        scope: ['deleted.ts'],
        kind: 'implementation-note',
        sourceRefs: ['deleted.ts'],
        sourceHashes: { 'deleted.ts': 'a'.repeat(64) },
        validationTaskId: 'task-missing',
        evidenceIds: ['evidence-2'],
        status: 'verified',
        lastVerifiedAt: '2026-07-11T00:00:00.000Z',
        createdAt: '2026-07-11T00:00:00.000Z',
        updatedAt: '2026-07-11T00:00:00.000Z',
      });

      const report = await verifySources(root);

      expect(report.missing).toContain('deleted.ts');
      expect(report.stale.map((r) => r.id)).toContain('wiki-missing');
    });

    it('leaves records with matching source hashes as verified', async () => {
      const root = await tempRoot();
      await writeFile(join(root, 'stable.ts'), 'stable content\n', 'utf8');
      const diffHash = await computeDiffHash(root);

      const actualHash = await import('node:crypto').then((crypto) => {
        const hash = crypto.createHash('sha256');
        hash.update('stable content\n');
        return hash.digest('hex');
      });

      const { writeWikiRecord } = await import('../../src/wiki/store.js');
      await writeWikiRecord(root, {
        id: 'wiki-stable',
        statement: 'Stable source Wiki.',
        scope: ['stable.ts'],
        kind: 'implementation-note',
        sourceRefs: ['stable.ts'],
        sourceHashes: { 'stable.ts': actualHash },
        validationTaskId: 'task-stable',
        evidenceIds: ['evidence-3'],
        status: 'verified',
        lastVerifiedAt: '2026-07-11T00:00:00.000Z',
        createdAt: '2026-07-11T00:00:00.000Z',
        updatedAt: '2026-07-11T00:00:00.000Z',
      });

      const report = await verifySources(root);
      expect(report.stale).toHaveLength(0);
      expect(report.intact).toContain('wiki-stable');
    });

    it('marks sourced records without source hashes as stale instead of intact', async () => {
      const root = await tempRoot();
      const { writeWikiRecord } = await import('../../src/wiki/store.js');
      await writeWikiRecord(root, {
        id: 'wiki-hashless',
        statement: 'Hashless Wiki cannot prove provenance.',
        scope: ['source.ts'],
        kind: 'implementation-note',
        sourceRefs: ['source.ts'],
        sourceHashes: {},
        validationTaskId: 'task-hashless',
        evidenceIds: ['evidence-hashless'],
        status: 'verified',
        lastVerifiedAt: '2026-07-11T00:00:00.000Z',
        createdAt: '2026-07-11T00:00:00.000Z',
        updatedAt: '2026-07-11T00:00:00.000Z',
      });

      const report = await verifySources(root);

      expect(report.intact).not.toContain('wiki-hashless');
      expect(report.stale).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'wiki-hashless',
            reason: 'source_missing',
          }),
        ]),
      );
    });
  });

  describe('5.4 Conflict checks against rules, specs, tests, and code', () => {
    it('detects conflicts with approved rules', async () => {
      const root = await tempRoot();
      const rulesDir = join(root, '.kata/rules');
      await writeFile(join(rulesDir, 'canonical-rule.md'), 'Approved policy: payment must use Stripe.\n', 'utf8');

      const result = await checkConflicts(root, {
        id: 'wiki-conflict',
        statement: 'Payment should use PayPal.',
        scope: ['payment/'],
        kind: 'implementation-note',
        sourceRefs: ['src/payment/service.ts'],
        sourceHashes: {},
        validationTaskId: 'task-conflict',
        evidenceIds: ['evidence-4'],
        status: 'candidate',
        lastVerifiedAt: '2026-07-11T00:00:00.000Z',
        createdAt: '2026-07-11T00:00:00.000Z',
        updatedAt: '2026-07-11T00:00:00.000Z',
      });

      expect(result.hasConflict).toBe(true);
      expect(result.conflicts.some((c) => c.type === 'rule' && c.source.includes('canonical-rule'))).toBe(true);
    });

    it('detects conflicts with test assertions', async () => {
      const root = await tempRoot();
      await (await import('node:fs/promises')).mkdir(join(root, 'tests/unit/payment'), { recursive: true });
      await writeFile(join(root, 'tests/unit/payment/service.test.ts'), 'expect(processor).toBe("stripe");\n', 'utf8');

      const result = await checkConflicts(root, {
        id: 'wiki-paypal',
        statement: 'Payment processor uses stripe.',
        scope: ['payment/'],
        kind: 'implementation-note',
        sourceRefs: ['src/payment/service.ts'],
        sourceHashes: {},
        validationTaskId: 'task-conflict-2',
        evidenceIds: ['evidence-5'],
        status: 'candidate',
        lastVerifiedAt: '2026-07-11T00:00:00.000Z',
        createdAt: '2026-07-11T00:00:00.000Z',
        updatedAt: '2026-07-11T00:00:00.000Z',
      });

      expect(result.hasConflict).toBe(true);
    });

    it('returns no conflicts for aligned Wiki records', async () => {
      const root = await tempRoot();
      const result = await checkConflicts(root, {
        id: 'wiki-aligned',
        statement: 'The system uses TypeScript interfaces for contracts.',
        scope: ['src/core/'],
        kind: 'architecture-note',
        sourceRefs: ['src/core/state.ts'],
        sourceHashes: {},
        validationTaskId: 'task-aligned',
        evidenceIds: ['evidence-6'],
        status: 'candidate',
        lastVerifiedAt: '2026-07-11T00:00:00.000Z',
        createdAt: '2026-07-11T00:00:00.000Z',
        updatedAt: '2026-07-11T00:00:00.000Z',
      });

      expect(result.hasConflict).toBe(false);
      expect(result.conflicts).toHaveLength(0);
    });
  });

  describe('5.5 Explicit approval and wiki promote', () => {
    it('promotes a candidate to verified with valid approval event', async () => {
      const root = await tempRoot();
      const { writeWikiRecord } = await import('../../src/wiki/store.js');
      await writeWikiRecord(root, {
        id: 'wiki-promote',
        statement: 'Approved Wiki knowledge.',
        scope: ['src/wiki/promotion.ts'],
        kind: 'implementation-note',
        sourceRefs: ['src/wiki/promotion.ts'],
        sourceHashes: {},
        validationTaskId: 'task-promote',
        evidenceIds: ['evidence-7'],
        status: 'candidate',
        lastVerifiedAt: '',
        createdAt: '2026-07-11T00:00:00.000Z',
        updatedAt: '2026-07-11T00:00:00.000Z',
      });

      const promoted = await promote(root, 'wiki-promote', {
        approvedBy: 'reviewer-1',
        role: 'reviewer',
        approvedAt: '2026-07-11T12:00:00.000Z',
        notes: 'Looks correct.',
      });

      expect(promoted.status).toBe('verified');
      expect(promoted.lastVerifiedAt).toBeTruthy();

      const records = await readWikiRecords(root);
      const found = records.find((r) => r.id === 'wiki-promote');
      expect(found?.status).toBe('verified');
      expect(found?.approvalEvent).toEqual({
        approvedBy: 'reviewer-1',
        role: 'reviewer',
        approvedAt: '2026-07-11T12:00:00.000Z',
        notes: 'Looks correct.',
      });
    });

    it('rejects promotion of non-existent Wiki records', async () => {
      const root = await tempRoot();
      await expect(
        promote(root, 'wiki-nonexistent', {
          approvedBy: 'reviewer-1',
          role: 'reviewer',
          approvedAt: '2026-07-11T12:00:00.000Z',
        }),
      ).rejects.toThrow(/not found/i);
    });

    it('rejects promotion of already verified records', async () => {
      const root = await tempRoot();
      const { writeWikiRecord } = await import('../../src/wiki/store.js');
      await writeWikiRecord(root, {
        id: 'wiki-already-verified',
        statement: 'Already verified.',
        scope: ['test'],
        kind: 'test',
        sourceRefs: ['test.ts'],
        sourceHashes: {},
        validationTaskId: 'task-already',
        evidenceIds: ['evidence-8'],
        status: 'verified',
        lastVerifiedAt: '2026-07-11T00:00:00.000Z',
        createdAt: '2026-07-11T00:00:00.000Z',
        updatedAt: '2026-07-11T00:00:00.000Z',
      });

      await expect(
        promote(root, 'wiki-already-verified', {
          approvedBy: 'reviewer-1',
          role: 'reviewer',
          approvedAt: '2026-07-11T12:00:00.000Z',
        }),
      ).rejects.toThrow(/already verified|status|candidate/i);
    });

    it('rejects a candidate with a rejection event', async () => {
      const root = await tempRoot();
      const { writeWikiRecord } = await import('../../src/wiki/store.js');
      await writeWikiRecord(root, {
        id: 'wiki-reject',
        statement: 'Rejected knowledge.',
        scope: ['test'],
        kind: 'test',
        sourceRefs: ['test.ts'],
        sourceHashes: {},
        validationTaskId: 'task-reject',
        evidenceIds: ['evidence-9'],
        status: 'candidate',
        lastVerifiedAt: '2026-07-11T00:00:00.000Z',
        createdAt: '2026-07-11T00:00:00.000Z',
        updatedAt: '2026-07-11T00:00:00.000Z',
      });

      const rejected = await rejectCandidate(root, 'wiki-reject', {
        rejectedBy: 'reviewer-1',
        role: 'reviewer',
        rejectedAt: '2026-07-11T12:00:00.000Z',
        reason: 'Inaccurate statement.',
      });

      expect(rejected.status).toBe('rejected');

      const records = await readWikiRecords(root);
      const found = records.find((r) => r.id === 'wiki-reject');
      expect(found?.status).toBe('rejected');
      expect(found?.rejectionEvent).toEqual({
        rejectedBy: 'reviewer-1',
        role: 'reviewer',
        rejectedAt: '2026-07-11T12:00:00.000Z',
        reason: 'Inaccurate statement.',
      });
    });
  });

  describe('5.6 Task-scoped Wiki context selection', () => {
    it('excludes stale and candidate records from authoritative context', async () => {
      const root = await tempRoot();
      const { writeWikiRecord } = await import('../../src/wiki/store.js');

      await writeWikiRecord(root, {
        id: 'wiki-auth',
        statement: 'Authoritative knowledge.',
        scope: ['src/core/'],
        kind: 'implementation-note',
        sourceRefs: ['src/core/state.ts'],
        sourceHashes: {},
        validationTaskId: 'task-auth',
        evidenceIds: ['e1'],
        status: 'verified',
        lastVerifiedAt: '2026-07-11T00:00:00.000Z',
        createdAt: '2026-07-11T00:00:00.000Z',
        updatedAt: '2026-07-11T00:00:00.000Z',
      });
      await writeWikiRecord(root, {
        id: 'wiki-excluded-candidate',
        statement: 'Candidate knowledge.',
        scope: ['src/'],
        kind: 'implementation-note',
        sourceRefs: ['src/core/state.ts'],
        sourceHashes: {},
        validationTaskId: 'task-cand',
        evidenceIds: ['e2'],
        status: 'candidate',
        lastVerifiedAt: '',
        createdAt: '2026-07-11T00:00:00.000Z',
        updatedAt: '2026-07-11T00:00:00.000Z',
      });

      const ctx = await selectAuthoritativeContext(root, ['src/core/state.ts']);
      expect(ctx.authoritative.map((r) => r.id)).toEqual(['wiki-auth']);
      expect(ctx.excluded.map((r) => r.id)).toContain('wiki-excluded-candidate');
    });

    it('emits warnings when reading stale-sourced Wiki', async () => {
      const root = await tempRoot();
      const { writeWikiRecord } = await import('../../src/wiki/store.js');
      await writeWikiRecord(root, {
        id: 'wiki-stale-warn',
        statement: 'Stale knowledge.',
        scope: ['src/stale.ts'],
        kind: 'implementation-note',
        sourceRefs: ['src/stale.ts'],
        sourceHashes: { 'src/stale.ts': 'a'.repeat(64) },
        validationTaskId: 'task-stale-warn',
        evidenceIds: ['e3'],
        status: 'stale',
        lastVerifiedAt: '2026-07-10T00:00:00.000Z',
        createdAt: '2026-07-10T00:00:00.000Z',
        updatedAt: '2026-07-10T00:00:00.000Z',
      });

      const ctx = await selectAuthoritativeContext(root, ['src/stale.ts']);
      expect(ctx.warnings.length).toBeGreaterThan(0);
      expect(ctx.warnings[0]).toContain('stale');
    });
  });
});
