import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { computeFileHash, type WikiRecord } from '../../src/wiki/record.js';
import { writeWikiRecord } from '../../src/wiki/store.js';
import { auditWiki } from '../../src/wiki/lifecycle.js';
import { retireWikiRecord } from '../../src/wiki/promotion.js';
import { main } from '../../src/cli.js';

describe('Wiki lifecycle recommendations', () => {
  const roots: string[] = [];

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-wiki-lifecycle-'));
    roots.push(root);
    await initLayout(root);
    await mkdir(join(root, '.llmwiki', 'concepts'), { recursive: true });
    await writeFile(join(root, '.llmwiki', 'SCHEMA.md'), '# Schema\n', 'utf8');
    await writeFile(join(root, '.llmwiki', 'index.md'), '# Index\n', 'utf8');
    await writeFile(join(root, '.llmwiki', 'log.md'), '# Log\n', 'utf8');
    return root;
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('classifies source, semantic, scope, duplicate, review-due, and over-budget risks', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'workflow.ts'), 'manual archive distillation\n', 'utf8');
    await writeFile(join(root, 'fresh.ts'), 'fresh source\n', 'utf8');
    const now = new Date('2026-07-14T00:00:00.000Z').toISOString();
    const old = new Date('2026-01-01T00:00:00.000Z').toISOString();

    await writeRecord(root, {
      id: 'wiki-old-manual',
      statement: 'All archive distillation must be manual for every Kata task.',
      scope: ['workflow.ts'],
      kind: 'workflow-convention',
      sourceRefs: ['workflow.ts'],
      sourceHashes: { 'workflow.ts': computeFileHash('manual archive distillation\n') },
      validationTaskId: 'old-task',
      status: 'verified',
      lastVerifiedAt: old,
    });
    await writeRecord(root, {
      id: 'wiki-new-auto',
      statement: 'Archive distillation now replaces manual classification with automatic deterministic capture.',
      scope: ['workflow.ts'],
      kind: 'workflow-convention',
      sourceRefs: ['fresh.ts'],
      sourceHashes: { 'fresh.ts': computeFileHash('fresh source\n') },
      validationTaskId: 'new-judge-pass-task',
      status: 'candidate',
      lastVerifiedAt: now,
    });
    await writeRecord(root, {
      id: 'wiki-duplicate-a',
      statement: 'Duplicate lifecycle note.',
      scope: ['fresh.ts'],
      kind: 'implementation-note',
      sourceRefs: ['fresh.ts'],
      sourceHashes: { 'fresh.ts': computeFileHash('fresh source\n') },
      validationTaskId: 'crowded-task',
      status: 'candidate',
      lastVerifiedAt: now,
    });
    await writeRecord(root, {
      id: 'wiki-duplicate-b',
      statement: 'Duplicate lifecycle note.',
      scope: ['fresh.ts'],
      kind: 'implementation-note',
      sourceRefs: ['fresh.ts'],
      sourceHashes: { 'fresh.ts': computeFileHash('fresh source\n') },
      validationTaskId: 'crowded-task',
      status: 'candidate',
      lastVerifiedAt: now,
    });
    await writeRecord(root, {
      id: 'wiki-missing-source',
      statement: 'Missing source should not be trusted.',
      scope: ['missing.ts'],
      kind: 'implementation-note',
      sourceRefs: ['missing.ts'],
      sourceHashes: { 'missing.ts': 'a'.repeat(64) },
      validationTaskId: 'crowded-task',
      status: 'candidate',
      lastVerifiedAt: now,
    });

    await writeFile(join(root, 'workflow.ts'), 'automatic archive distillation\n', 'utf8');

    const audit = await auditWiki(root);

    expect(audit.recommendedActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'wiki-old-manual',
          reasons: expect.arrayContaining(['source_changed', 'semantic_superseded', 'scope_changed', 'review_due']),
          recommendedAction: 'retire',
          successorIds: ['wiki-new-auto'],
        }),
        expect.objectContaining({
          id: 'wiki-missing-source',
          reasons: expect.arrayContaining(['source_missing', 'candidate_over_budget']),
          recommendedAction: 'retire',
        }),
        expect.objectContaining({
          id: 'wiki-duplicate-a',
          reasons: expect.arrayContaining(['duplicate', 'candidate_over_budget']),
          recommendedAction: expect.stringMatching(/merge|retire_duplicate|review/),
        }),
      ]),
    );
  });

  it('recommends a review for the mirror direction too, where a hash names a path the record does not declare', async () => {
    // **The other half of the same question.** A record whose `sourceHashes` lists a path its `sourceRefs` do not declare was
    // reported `source_changed` and recommended `revalidate`, which refuses it by name (measured by an independent round after
    // the first repair closed only one direction). One predicate now answers both, and this case pins the action for the
    // mirror direction so a later edit cannot map one of them to the wrong road.
    const root = await tempRoot();
    await writeFile(join(root, 'docs-declared.md'), 'declared\n', 'utf8');
    await writeFile(join(root, 'docs-extra.md'), 'extra\n', 'utf8');
    await writeRecord(root, {
      id: 'wiki-half-undeclared',
      statement: 'A record with a hash for a path it does not declare.',
      scope: ['docs-declared.md'],
      kind: 'implementation-note',
      sourceRefs: ['docs-declared.md'],
      sourceHashes: { 'docs-declared.md': computeFileHash('declared\n'), 'docs-extra.md': computeFileHash('other\n') },
      validationTaskId: 'a-task',
      status: 'candidate',
    });

    const audit = await auditWiki(root);

    expect(audit.recommendedActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'wiki-half-undeclared', reasons: expect.arrayContaining(['source_undeclared']), recommendedAction: 'review' }),
      ]),
    );
  });

  it('recommends a review, not a re-derivation, for a record whose source was never recorded', async () => {
    // **The recommendation follows the cause.** A record declaring a source it has no hash for was reported `source_changed`,
    // which `chooseAction` maps to `revalidate` — a command that refuses that record by name (measured by an independent
    // round). The cause has its own word now, and the load-bearing half of this case is that word: with it folded back into
    // `source_changed` the outcome below becomes `revalidate` again (falsifier E23). The explicit mapping line in
    // `chooseAction` is a statement of the decision rather than the only thing producing `review` — the fall-through yields
    // it too — and it is written that way so a later edit cannot attach the wrong road to this cause.
    const root = await tempRoot();
    await writeFile(join(root, 'docs-second.md'), 'second\n', 'utf8');
    await writeRecord(root, {
      id: 'wiki-half-recorded',
      statement: 'A record with a source it never hashed.',
      scope: ['docs-first.md', 'docs-second.md'],
      kind: 'implementation-note',
      sourceRefs: ['docs-first.md', 'docs-second.md'],
      sourceHashes: { 'docs-first.md': computeFileHash('first\n') },
      validationTaskId: 'a-task',
      status: 'candidate',
    });
    await writeFile(join(root, 'docs-first.md'), 'first\n', 'utf8');

    const audit = await auditWiki(root);

    expect(audit.recommendedActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'wiki-half-recorded', reasons: expect.arrayContaining(['source_unrecorded']), recommendedAction: 'review' }),
      ]),
    );
  });

  it('retires a governed record without deleting its .llmwiki page', async () => {
    const root = await tempRoot();
    await writeFile(join(root, '.llmwiki', 'concepts', 'old-rule.md'), '# Old Rule\n', 'utf8');
    await writeRecord(root, {
      id: 'wiki-old-rule',
      statement: 'Old rule.',
      scope: ['.llmwiki/concepts/old-rule.md'],
      kind: 'concept',
      sourceRefs: ['.llmwiki/concepts/old-rule.md'],
      sourceHashes: { '.llmwiki/concepts/old-rule.md': computeFileHash('# Old Rule\n') },
      validationTaskId: 'old-task',
      status: 'verified',
    });

    const retired = await retireWikiRecord(root, 'wiki-old-rule', {
      rejectedBy: 'distiller',
      role: 'distiller',
      rejectedAt: '2026-07-14T00:00:00.000Z',
      reason: 'retired: superseded by wiki-new-rule',
    });

    expect(retired.status).toBe('rejected');
    expect(retired.rejectionEvent?.reason).toContain('retired:');
    await expect(readFile(join(root, '.llmwiki', 'concepts', 'old-rule.md'), 'utf8')).resolves.toContain('Old Rule');
  });

  it('routes lifecycle and retire through the wiki CLI', async () => {
    const root = await tempRoot();
    await writeFile(join(root, 'source.ts'), 'source\n', 'utf8');
    await writeRecord(root, {
      id: 'wiki-cli-retire',
      statement: 'CLI retire target.',
      scope: ['source.ts'],
      kind: 'implementation-note',
      sourceRefs: ['source.ts'],
      sourceHashes: { 'source.ts': computeFileHash('source\n') },
      validationTaskId: 'cli-task',
      status: 'candidate',
    });

    const lifecycle = await captureJsonOutput(() => main(['wiki', 'lifecycle', '--root', root]));
    expect(lifecycle).toMatchObject({ command: 'wiki lifecycle', recommendedActions: expect.any(Array) });

    const retire = await captureJsonOutput(() =>
      main(['wiki', 'retire', 'wiki-cli-retire', '--root', root, '--by', 'distiller', '--role', 'distiller', '--reason', 'superseded']),
    );
    expect(retire).toMatchObject({
      command: 'wiki retire',
      id: 'wiki-cli-retire',
      status: 'rejected',
      reason: expect.stringContaining('retired:'),
    });
  });
});

async function writeRecord(
  root: string,
  input: Omit<WikiRecord, 'evidenceIds' | 'createdAt' | 'updatedAt' | 'lastVerifiedAt'> & Partial<Pick<WikiRecord, 'evidenceIds' | 'createdAt' | 'updatedAt' | 'lastVerifiedAt'>>,
): Promise<void> {
  await writeWikiRecord(root, {
    evidenceIds: ['evidence-1'],
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
    lastVerifiedAt: '2026-07-14T00:00:00.000Z',
    ...input,
  });
}

async function captureJsonOutput(action: () => Promise<void>): Promise<Record<string, unknown>> {
  const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await action();
    const output = write.mock.calls.at(-1)?.[0];
    if (typeof output !== 'string') throw new Error('expected JSON console output');
    return JSON.parse(output.trim()) as Record<string, unknown>;
  } finally {
    write.mockRestore();
  }
}
