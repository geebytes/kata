import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ingestLlmWiki, initLlmWiki, lintLlmWiki, orientLlmWiki, queryLlmWiki } from '../../src/wiki/llmwiki.js';
import { main } from '../../src/cli.js';
import { readWikiRecords } from '../../src/wiki/store.js';

describe('LLM Wiki', () => {
  const roots: string[] = [];

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kata-llmwiki-'));
    roots.push(root);
    return root;
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('initializes a project .llmwiki from a specified documentation path', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'docs', 'developer'), { recursive: true });
    await writeFile(join(root, 'docs', 'developer', 'architecture.md'), '# Architecture\n\nAgents need context.\n', 'utf8');
    await writeFile(join(root, 'docs', 'notes.txt'), 'Important project notes.\n', 'utf8');
    await writeFile(join(root, 'docs', 'ignored.json'), '{}\n', 'utf8');

    const result = await initLlmWiki({ root, from: join(root, 'docs') });

    expect(result.wikiPath).toBe('.llmwiki');
    expect(result.importedSources).toEqual(['raw/docs/developer/architecture.md', 'raw/docs/notes.txt']);
    await expect(readFile(join(root, '.llmwiki/SCHEMA.md'), 'utf8')).resolves.toContain('Project LLM Wiki');
    await expect(readFile(join(root, '.llmwiki/index.md'), 'utf8')).resolves.toContain('[[raw/docs/developer/architecture.md]]');
    await expect(readFile(join(root, '.llmwiki/log.md'), 'utf8')).resolves.toContain('init | Project LLM Wiki initialized');
    const raw = await readFile(join(root, '.llmwiki/raw/docs/developer/architecture.md'), 'utf8');
    expect(raw).toContain('source_path: docs/developer/architecture.md');
    expect(raw).toMatch(/sha256: [a-f0-9]{64}/);
  });

  it('orients agents by reading schema, index, and recent log', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'guide.md'), '# Guide\n\nUse Kata.\n', 'utf8');
    await initLlmWiki({ root, from: join(root, 'docs') });

    const orientation = await orientLlmWiki({ root });

    expect(orientation.schema).toContain('Project LLM Wiki');
    expect(orientation.index).toContain('[[raw/docs/guide.md]]');
    expect(orientation.recentLog).toContain('init | Project LLM Wiki initialized');
  });

  it('lints the .llmwiki structure and source hashes', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'guide.md'), '# Guide\n\nUse Kata.\n', 'utf8');
    await initLlmWiki({ root, from: join(root, 'docs') });

    const clean = await lintLlmWiki({ root });
    expect(clean.ok).toBe(true);
    expect(clean.issues).toEqual([]);

    await writeFile(join(root, '.llmwiki/raw/docs/guide.md'), '# edited raw source\n', 'utf8');
    const dirty = await lintLlmWiki({ root });
    expect(dirty.ok).toBe(false);
    expect(dirty.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'high', code: 'raw_source_hash_mismatch', path: 'raw/docs/guide.md' }),
      ]),
    );
  });

  it('routes CLI wiki init/orient/lint commands', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'guide.md'), '# Guide\n\nUse Kata.\n', 'utf8');

    const init = await captureJsonOutput(() => main(['wiki', 'init', '--from', join(root, 'docs'), '--root', root]));
    expect(init).toMatchObject({ command: 'wiki init', wikiPath: '.llmwiki', importedCount: 1 });

    const orient = await captureJsonOutput(() => main(['wiki', 'orient', '--root', root]));
    expect(orient).toMatchObject({ command: 'wiki orient', wikiPath: '.llmwiki' });

    const lint = await captureJsonOutput(() => main(['wiki', 'lint', '--root', root]));
    expect(lint).toMatchObject({ command: 'wiki lint', wikiPath: '.llmwiki', ok: true });
  });

  it('makes wiki commands discoverable and supports safe proposal aliases', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'guide.md'), '# Guide\n\nUse Kata.\n', 'utf8');
    await main(['wiki', 'init', '--from', join(root, 'docs'), '--root', root]);

    const help = await captureJsonOutput(() => main(['wiki', '--help', '--root', root]));
    expect(help).toMatchObject({ command: 'wiki help' });
    expect(help.commands).toEqual(expect.arrayContaining(['task --kind enrich', 'register', 'candidate']));

    const proposal = await captureJsonOutput(() => main(['wiki', 'propose', '--task', 'example-task', '--from', 'docs', '--root', root]));
    expect(proposal).toMatchObject({ command: 'wiki task', kind: 'enrich', sourceTask: 'example-task' });

    const candidates = await captureJsonOutput(() => main(['wiki', 'candidate', '--root', root]));
    expect(candidates).toMatchObject({ command: 'wiki candidate', candidates: [] });
  });

  it('ingests new sources into summary pages, index, log, and governed Wiki candidates', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'api.md'), '# Gateway API\n\nThe Gateway API normalizes agent requests.\n', 'utf8');
    await initLlmWiki({ root, from: join(root, 'docs') });

    await writeFile(join(root, 'docs', 'runtime.md'), '# Runtime\n\nRuntime roles are api, worker, and scheduler.\n', 'utf8');
    const result = await ingestLlmWiki({ root, from: join(root, 'docs', 'runtime.md') });

    expect(result.importedSources).toEqual(['raw/docs/runtime.md']);
    expect(result.pagesWritten).toEqual(['concepts/runtime.md']);
    await expect(readFile(join(root, '.llmwiki/concepts/runtime.md'), 'utf8')).resolves.toContain('kata_record_id: llmwiki-runtime');
    await expect(readFile(join(root, '.llmwiki/index.md'), 'utf8')).resolves.toContain('[[concepts/runtime.md]]');
    await expect(readFile(join(root, '.llmwiki/log.md'), 'utf8')).resolves.toContain('ingest | runtime.md');

    const records = await readWikiRecords(root);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'llmwiki-runtime',
          status: 'candidate',
          kind: 'llmwiki-summary',
          scope: ['concepts/runtime.md'],
          sourceRefs: expect.arrayContaining(['.llmwiki/raw/docs/runtime.md', '.llmwiki/concepts/runtime.md']),
        }),
      ]),
    );
  });

  it('queries compiled wiki pages with citations and files valuable answers', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'gateway.md'), '# Gateway API\n\nThe Gateway API normalizes agent requests.\n', 'utf8');
    await initLlmWiki({ root, from: join(root, 'docs') });
    await ingestLlmWiki({ root, from: join(root, 'docs', 'gateway.md') });

    const result = await queryLlmWiki({ root, query: 'How does the Gateway API help agents?', file: true });

    expect(result.citations).toContain('concepts/gateway.md');
    expect(result.answer).toContain('Gateway API');
    expect(result.filedPath).toBe('queries/how-does-the-gateway-api-help-agents.md');
    await expect(readFile(join(root, '.llmwiki/queries/how-does-the-gateway-api-help-agents.md'), 'utf8')).resolves.toContain('Based on [[concepts/gateway.md]]');
    await expect(readFile(join(root, '.llmwiki/log.md'), 'utf8')).resolves.toContain('query | How does the Gateway API help agents?');
  });

  it('lints broken wikilinks, orphan pages, missing index entries, and invalid frontmatter', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'gateway.md'), '# Gateway API\n\nThe Gateway API normalizes agent requests.\n', 'utf8');
    await initLlmWiki({ root, from: join(root, 'docs') });
    await ingestLlmWiki({ root, from: join(root, 'docs', 'gateway.md') });

    await writeFile(
      join(root, '.llmwiki/concepts/orphan.md'),
      '# Orphan\n\nLinks to [[missing-target]].\n',
      'utf8',
    );

    const report = await lintLlmWiki({ root });

    expect(report.ok).toBe(false);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'missing_frontmatter', path: 'concepts/orphan.md' }),
        expect.objectContaining({ code: 'broken_wikilink', path: 'concepts/orphan.md' }),
        expect.objectContaining({ code: 'missing_index_entry', path: 'concepts/orphan.md' }),
        expect.objectContaining({ code: 'orphan_page', path: 'concepts/orphan.md' }),
      ]),
    );
  });

  it('routes CLI wiki ingest and query commands', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'gateway.md'), '# Gateway API\n\nThe Gateway API normalizes agent requests.\n', 'utf8');
    await main(['wiki', 'init', '--from', join(root, 'docs'), '--root', root]);

    const ingest = await captureJsonOutput(() => main(['wiki', 'ingest', '--from', join(root, 'docs', 'gateway.md'), '--root', root]));
    expect(ingest).toMatchObject({ command: 'wiki ingest', wikiPath: '.llmwiki', importedCount: 1, pagesWritten: ['concepts/gateway.md'] });

    const query = await captureJsonOutput(() => main(['wiki', 'query', '--q', 'Gateway API agents', '--file', '--root', root]));
    expect(query).toMatchObject({ command: 'wiki query', wikiPath: '.llmwiki', citations: ['concepts/gateway.md'] });
  });

  it('routes CLI wiki verify and promote commands for governed records', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'gateway.md'), '# Gateway API\n\nThe Gateway API normalizes agent requests.\n', 'utf8');
    await main(['wiki', 'init', '--from', join(root, 'docs'), '--root', root]);
    await main(['wiki', 'ingest', '--from', join(root, 'docs', 'gateway.md'), '--root', root]);

    const verify = await captureJsonOutput(() => main(['wiki', 'verify', '--root', root]));
    expect(verify).toMatchObject({ command: 'wiki verify', checked: 1, stale: [] });

    const promote = await captureJsonOutput(() =>
      main(['wiki', 'promote', 'llmwiki-gateway', '--root', root, '--by', 'reviewer-1', '--role', 'reviewer']),
    );
    expect(promote).toMatchObject({
      command: 'wiki promote',
      id: 'llmwiki-gateway',
      status: 'verified',
      approvedBy: 'reviewer-1',
      role: 'reviewer',
    });
  });

  it('emits deterministic wiki task packets for coding-agent LLM enrichment', async () => {
    const root = await tempRoot();
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'gateway.md'), '# Gateway API\n\nThe Gateway API normalizes agent requests.\n', 'utf8');
    await main(['wiki', 'init', '--from', join(root, 'docs'), '--root', root]);

    const task = await captureJsonOutput(() =>
      main(['wiki', 'task', '--kind', 'enrich', '--root', root, '--from', 'docs']),
    );

    expect(task).toMatchObject({
      command: 'wiki task',
      kind: 'enrich',
      requiredReads: expect.arrayContaining([
        '.llmwiki/SCHEMA.md',
        '.llmwiki/index.md',
        '.llmwiki/log.md',
        '.llmwiki/raw/docs/gateway.md',
      ]),
      writeTargets: expect.arrayContaining(['.llmwiki/concepts/', '.llmwiki/entities/', '.llmwiki/comparisons/']),
      followupCommands: expect.arrayContaining(['kata wiki lint --root <root>']),
    });
    expect(task.instructions).toEqual(expect.arrayContaining([expect.stringContaining('coding agent')]));
    expect(JSON.stringify(task)).not.toMatch(/apiKey|OPENAI|ANTHROPIC/i);
  });
});

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
