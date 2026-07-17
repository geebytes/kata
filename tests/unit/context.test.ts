import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initLayout } from '../../src/core/layout.js';
import { buildContextManifest } from '../../src/core/context.js';

describe('Kata context manifest', () => {
  const roots: string[] = [];

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-context-'));
    roots.push(root);
    await initLayout(root);
    return root;
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('excludes candidate and stale Wiki records from authoritative context and warns on stale source reads', async () => {
    const root = await tempRoot();
    const baseRecord = {
      statement: 'Only verified Wiki can shape implementation context.',
      scope: ['src/core/context.ts'],
      kind: 'implementation-note',
      sourceRefs: ['src/core/context.ts'],
      sourceHashes: { 'src/core/context.ts': 'a'.repeat(64) },
      validationTaskId: 'task-context',
      evidenceIds: ['evidence-1'],
      lastVerifiedAt: '2026-07-11T00:00:00.000Z',
    };

    await writeFile(
      join(root, '.kata/wiki/verified.json'),
      `${JSON.stringify({ ...baseRecord, id: 'wiki-verified', status: 'verified' }, null, 2)}\n`,
    );
    await writeFile(
      join(root, '.kata/wiki/candidate.json'),
      `${JSON.stringify({ ...baseRecord, id: 'wiki-candidate', status: 'candidate' }, null, 2)}\n`,
    );
    await writeFile(
      join(root, '.kata/wiki/stale.json'),
      `${JSON.stringify({ ...baseRecord, id: 'wiki-stale', status: 'stale' }, null, 2)}\n`,
    );

    const manifest = await buildContextManifest({
      root,
      taskId: 'task-context',
      sourceRefs: ['src/core/context.ts'],
    });

    expect(manifest.authoritativeWiki.map((record) => record.id)).toEqual(['wiki-verified']);
    expect(manifest.excludedWiki).toEqual([
      { id: 'wiki-candidate', status: 'candidate', reason: 'not-authoritative' },
      { id: 'wiki-stale', status: 'stale', reason: 'stale' },
    ]);
    expect(manifest.warnings).toContain(
      'Source src/core/context.ts has stale Wiki record wiki-stale; read source before relying on Wiki.',
    );
  });

  it('includes only verified Wiki records relevant to requested source references', async () => {
    const root = await tempRoot();
    const baseRecord = {
      statement: 'Relevant verified Wiki can shape implementation context.',
      kind: 'implementation-note',
      sourceHashes: {},
      validationTaskId: 'task-context',
      evidenceIds: ['evidence-1'],
      status: 'verified',
      lastVerifiedAt: '2026-07-11T00:00:00.000Z',
    };

    await writeFile(
      join(root, '.kata/wiki/requested-source.json'),
      `${JSON.stringify(
        {
          ...baseRecord,
          id: 'wiki-requested-source',
          scope: ['src/core/context.ts'],
          sourceRefs: ['src/core/context.ts'],
          sourceHashes: { 'src/core/context.ts': 'a'.repeat(64) },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      join(root, '.kata/wiki/unrelated-source.json'),
      `${JSON.stringify(
        {
          ...baseRecord,
          id: 'wiki-unrelated-source',
          statement: 'Unrelated verified Wiki must not shape this context.',
          scope: ['src/core/recovery.ts'],
          sourceRefs: ['src/core/recovery.ts'],
          sourceHashes: { 'src/core/recovery.ts': 'b'.repeat(64) },
        },
        null,
        2,
      )}\n`,
    );

    const manifest = await buildContextManifest({
      root,
      taskId: 'task-context',
      sourceRefs: ['src/core/context.ts'],
    });

    expect(manifest.authoritativeWiki.map((record) => record.id)).toEqual(['wiki-requested-source']);
    expect(manifest.authoritativeWiki.map((record) => record.sourceRefs)).toEqual([['src/core/context.ts']]);
  });
});
