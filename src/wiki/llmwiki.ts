import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { writeWikiRecord } from './store.js';
import { computeFileHash } from './record.js';

export interface LlmWikiInput {
  root?: string;
  wikiPath?: string;
}

export interface InitLlmWikiInput extends LlmWikiInput {
  from: string;
}

export interface LlmWikiInitResult {
  wikiPath: string;
  importedSources: string[];
  schemaPath: string;
  indexPath: string;
  logPath: string;
}

export interface LlmWikiOrientation {
  wikiPath: string;
  schema: string;
  index: string;
  recentLog: string;
}

export interface LlmWikiLintIssue {
  severity: 'critical' | 'high' | 'medium' | 'low';
  code: string;
  path: string;
  message: string;
}

export interface LlmWikiLintReport {
  wikiPath: string;
  ok: boolean;
  issues: LlmWikiLintIssue[];
}

export interface IngestLlmWikiInput extends LlmWikiInput {
  from: string;
}

export interface LlmWikiIngestResult {
  wikiPath: string;
  importedSources: string[];
  pagesWritten: string[];
  governedRecords: string[];
}

export interface QueryLlmWikiInput extends LlmWikiInput {
  query: string;
  file?: boolean;
}

export interface LlmWikiQueryResult {
  wikiPath: string;
  query: string;
  answer: string;
  citations: string[];
  filedPath?: string;
}

export interface LlmWikiTaskInput extends LlmWikiInput {
  kind: 'bootstrap' | 'enrich' | 'distill';
  from?: string;
}

export interface LlmWikiTaskPacket {
  command: 'wiki task';
  kind: LlmWikiTaskInput['kind'];
  wikiPath: string;
  requiredReads: string[];
  writeTargets: string[];
  instructions: string[];
  followupCommands: string[];
}

export interface LlmWikiRegisterResult {
  command: 'wiki register';
  wikiPath: string;
  registered: number;
  skipped: number;
  pages: string[];
}

export interface LlmWikiRebuildResult {
  command: 'wiki rebuild';
  wikiPath: string;
  cleaned: { pages: number; records: number };
  taskPacketPath: string;
}

const defaultWikiPath = '.llmwiki';
const sourceExtensions = new Set(['.md', '.mdx', '.txt']);
const requiredDirectories = [
  'raw/docs',
  'raw/articles',
  'raw/papers',
  'raw/assets',
  'entities',
  'concepts',
  'comparisons',
  'queries',
];

export async function initLlmWiki(input: InitLlmWikiInput): Promise<LlmWikiInitResult> {
  const root = resolve(input.root ?? process.cwd());
  const wikiPath = normalizeWikiPath(input.wikiPath);
  const wikiRoot = resolveWikiRoot(root, wikiPath);
  const fromRoot = resolve(root, input.from);
  const sourceFiles = await collectSourceFiles(fromRoot);
  const importedSources: string[] = [];

  await mkdir(wikiRoot, { recursive: true });
  for (const directory of requiredDirectories) {
    await mkdir(join(wikiRoot, directory), { recursive: true });
  }

  for (const sourceFile of sourceFiles) {
    const relativeToSourceRoot = relative(fromRoot, sourceFile).replaceAll('\\', '/');
    const destination = `raw/docs/${relativeToSourceRoot}`;
    const body = await readFile(sourceFile, 'utf8');
    const sourcePath = normalizeSourcePath(root, sourceFile);
    const rawContent = renderRawSource(sourcePath, body);
    await mkdir(dirname(join(wikiRoot, destination)), { recursive: true });
    await writeFile(join(wikiRoot, destination), rawContent, 'utf8');
    importedSources.push(destination);
  }

  const now = new Date().toISOString();
  await writeFile(join(wikiRoot, 'SCHEMA.md'), renderSchema(now), 'utf8');
  await writeFile(join(wikiRoot, 'index.md'), renderIndex(importedSources, now), 'utf8');
  await writeFile(join(wikiRoot, 'log.md'), renderLog(importedSources, now), 'utf8');

  return {
    wikiPath,
    importedSources,
    schemaPath: 'SCHEMA.md',
    indexPath: 'index.md',
    logPath: 'log.md',
  };
}

export async function orientLlmWiki(input: LlmWikiInput = {}): Promise<LlmWikiOrientation> {
  const root = resolve(input.root ?? process.cwd());
  const wikiPath = normalizeWikiPath(input.wikiPath);
  const wikiRoot = resolveWikiRoot(root, wikiPath);
  const schema = await readFile(join(wikiRoot, 'SCHEMA.md'), 'utf8');
  const index = await readFile(join(wikiRoot, 'index.md'), 'utf8');
  const log = await readFile(join(wikiRoot, 'log.md'), 'utf8');
  const recentLog = log.trim().split('\n').slice(-30).join('\n');
  return { wikiPath, schema, index, recentLog };
}

export async function ingestLlmWiki(input: IngestLlmWikiInput): Promise<LlmWikiIngestResult> {
  const root = resolve(input.root ?? process.cwd());
  const wikiPath = normalizeWikiPath(input.wikiPath);
  const wikiRoot = resolveWikiRoot(root, wikiPath);
  const fromPath = resolve(root, input.from);
  const sourceFiles = await collectSourceFiles(fromPath);
  const importedSources: string[] = [];
  const pagesWritten: string[] = [];
  const governedRecords: string[] = [];

  for (const sourceFile of sourceFiles) {
    const slug = slugify(sourceFile.replace(/\.[^.]+$/, '').split(/[\\/]/).pop() ?? 'source');
    const destination = `raw/docs/${slug}${extname(sourceFile).toLowerCase() || '.md'}`;
    const body = await readFile(sourceFile, 'utf8');
    await mkdir(dirname(join(wikiRoot, destination)), { recursive: true });
    await writeFile(join(wikiRoot, destination), renderRawSource(normalizeSourcePath(root, sourceFile), body), 'utf8');
    importedSources.push(destination);

    const pagePath = `concepts/${slug}.md`;
    const recordId = `llmwiki-${slug}`;
    const page = renderSummaryPage({
      title: titleFromMarkdown(body) ?? titleFromSlug(slug),
      slug,
      recordId,
      rawSource: destination,
      body,
    });
    await mkdir(dirname(join(wikiRoot, pagePath)), { recursive: true });
    await writeFile(join(wikiRoot, pagePath), page, 'utf8');
    pagesWritten.push(pagePath);

    await upsertIndexEntry(wikiRoot, 'Concepts', pagePath, oneLineSummary(body));
    await appendLog(wikiRoot, `ingest | ${slug}${extname(sourceFile).toLowerCase() || '.md'}`, [
      `- Imported: ${destination}`,
      `- Updated: ${pagePath}`,
      `- Governed record: ${recordId}`,
    ]);

    const rawContent = await readFile(join(wikiRoot, destination), 'utf8');
    const pageContent = await readFile(join(wikiRoot, pagePath), 'utf8');
    await writeWikiRecord(root, {
      id: recordId,
      statement: oneLineSummary(body),
      scope: [pagePath],
      kind: 'llmwiki-summary',
      sourceRefs: [`.llmwiki/${destination}`, `.llmwiki/${pagePath}`],
      sourceHashes: {
        [`.llmwiki/${destination}`]: computeFileHash(rawContent),
        [`.llmwiki/${pagePath}`]: computeFileHash(pageContent),
      },
      validationTaskId: 'llmwiki-ingest',
      evidenceIds: [`llmwiki-${sha256(rawContent).slice(0, 12)}`],
      status: 'candidate',
      lastVerifiedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    governedRecords.push(recordId);
  }

  return { wikiPath, importedSources, pagesWritten, governedRecords };
}

export async function queryLlmWiki(input: QueryLlmWikiInput): Promise<LlmWikiQueryResult> {
  const root = resolve(input.root ?? process.cwd());
  const wikiPath = normalizeWikiPath(input.wikiPath);
  const wikiRoot = resolveWikiRoot(root, wikiPath);
  await orientLlmWiki({ root, wikiPath });

  const pages = await collectWikiPages(wikiRoot);
  const scored = await Promise.all(
    pages.map(async (page) => {
      const content = await readFile(join(wikiRoot, page), 'utf8');
      return { page, content, score: scoreContent(input.query, content, page) };
    }),
  );
  const matches = scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
  const citations = matches.map((item) => item.page);
  const answer = renderQueryAnswer(input.query, matches);
  let filedPath: string | undefined;

  if (input.file) {
    filedPath = `queries/${slugify(input.query)}.md`;
    await mkdir(dirname(join(wikiRoot, filedPath)), { recursive: true });
    await writeFile(join(wikiRoot, filedPath), renderQueryPage(input.query, answer, citations), 'utf8');
    await upsertIndexEntry(wikiRoot, 'Queries', filedPath, `Filed answer for: ${input.query}`);
  }

  await appendLog(wikiRoot, `query | ${input.query}`, [
    `- Citations: ${citations.join(', ') || 'none'}`,
    ...(filedPath ? [`- Filed: ${filedPath}`] : []),
  ]);

  return { wikiPath, query: input.query, answer, citations, ...(filedPath ? { filedPath } : {}) };
}

export async function buildLlmWikiTask(input: LlmWikiTaskInput): Promise<LlmWikiTaskPacket> {
  const root = resolve(input.root ?? process.cwd());
  const wikiPath = normalizeWikiPath(input.wikiPath);
  const wikiRoot = resolveWikiRoot(root, wikiPath);
  const wikiRawDocsRoot = join(wikiRoot, 'raw/docs');
  const wikiSourceFiles = await collectSourceFiles(wikiRawDocsRoot);
  const sourceFiles = wikiSourceFiles.length > 0
    ? wikiSourceFiles
    : input.from
      ? await collectSourceFiles(resolve(root, input.from))
      : [];
  const rawReads = sourceFiles
    .map((sourceFile) => normalizeTaskRead(root, wikiRoot, wikiPath, sourceFile))
    .filter((path) => path.startsWith(`${wikiPath}/`) || path.startsWith('.llmwiki/'))
    .sort((left, right) => left.localeCompare(right));

  return {
    command: 'wiki task',
    kind: input.kind,
    wikiPath,
    requiredReads: [
      `${wikiPath}/SCHEMA.md`,
      `${wikiPath}/index.md`,
      `${wikiPath}/log.md`,
      ...rawReads,
    ],
    writeTargets: [
      `${wikiPath}/concepts/`,
      `${wikiPath}/entities/`,
      `${wikiPath}/comparisons/`,
      `${wikiPath}/queries/`,
    ],
    instructions: instructionsForWikiTask(input.kind),
    followupCommands: [
      'kata wiki lint --root <root>',
      'kata wiki verify --root <root>',
      'kata wiki register --root <root>',
      'kata orient --change <change-id> --role distiller --task-kind read',
    ],
  };
}

const wikiPageDirectories = ['concepts', 'entities', 'comparisons', 'queries'] as const;

export async function registerWikiPages(input: LlmWikiInput = {}): Promise<LlmWikiRegisterResult> {
  const root = resolve(input.root ?? process.cwd());
  const wikiPath = normalizeWikiPath(input.wikiPath);
  const wikiRoot = resolveWikiRoot(root, wikiPath);
  const existing = new Set(await collectExistingRecordIds(root));
  const registered: string[] = [];
  let skipped = 0;

  for (const dir of wikiPageDirectories) {
    const dirPath = join(wikiRoot, dir);
    const files = await collectSourceFiles(dirPath);
    for (const file of files) {
      const relativePath = relative(wikiRoot, file).replaceAll('\\', '/');
      const recordId = `llmwiki-${relativePath.replace(/[/\\]/g, '-').replace(/\.[^.]+$/, '')}`;
      if (existing.has(recordId)) {
        skipped += 1;
        continue;
      }
      const content = await readFile(file, 'utf8');
      const frontmatter = parsePageFrontmatter(content);
      const statement = frontmatter ? Object.values(frontmatter).join('; ') : oneLineSummary(content);
      await writeWikiRecord(root, {
        id: recordId,
        statement,
        scope: [`.llmwiki/${relativePath}`],
        kind: 'llmwiki-summary',
        sourceRefs: [`.llmwiki/${relativePath}`],
        sourceHashes: { [`.llmwiki/${relativePath}`]: computeFileHash(content) },
        validationTaskId: 'llmwiki-register',
        evidenceIds: [`llmwiki-${sha256(content).slice(0, 12)}`],
        status: 'candidate',
        lastVerifiedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      registered.push(relativePath);
    }
  }

  await appendLog(wikiRoot, `register | ${registered.length} pages`, registered.map((p) => `- ${p}`));

  return { command: 'wiki register', wikiPath, registered: registered.length, skipped, pages: registered };
}

async function collectExistingRecordIds(root: string): Promise<string[]> {
  const wikiDir = join(root, '.kata/wiki');
  try {
    const entries = await readdir(wikiDir);
    return entries.filter((e) => e.endsWith('.json')).map((e) => e.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

export async function rebuildLlmWiki(input: LlmWikiInput = {}): Promise<LlmWikiRebuildResult> {
  const root = resolve(input.root ?? process.cwd());
  const wikiPath = normalizeWikiPath(input.wikiPath);
  const wikiRoot = resolveWikiRoot(root, wikiPath);
  let cleanedPages = 0;
  let cleanedRecords = 0;

  for (const dir of wikiPageDirectories) {
    const dirPath = join(wikiRoot, dir);
    try {
      const files = await readdir(dirPath);
      for (const file of files) {
        await rm(join(dirPath, file), { force: true });
        cleanedPages += 1;
      }
    } catch {}
  }

  const wikiDir = join(root, '.kata/wiki');
  try {
    const files = await readdir(wikiDir);
    for (const file of files) {
      if (file.endsWith('.json')) {
        await rm(join(wikiDir, file), { force: true });
        cleanedRecords += 1;
      }
    }
  } catch {}

  const taskPacketPath = join(root, '.kata/tasks/wiki-enrich/task-packet.json');
  const wrapDir = join(root, '.kata/tasks/wiki-enrich');
  await mkdir(wrapDir, { recursive: true });
  const enrichTask = await buildLlmWikiTask({ root, kind: 'enrich' });
  await writeFile(taskPacketPath, `${JSON.stringify(enrichTask, null, 2)}\n`);

  await appendLog(wikiRoot, 'rebuild | wiki cleaned and task-packet regenerated', [
    `- Pages removed: ${cleanedPages}`,
    `- Records removed: ${cleanedRecords}`,
    `- Task packet: ${taskPacketPath}`,
  ]);

  return { command: 'wiki rebuild', wikiPath, cleaned: { pages: cleanedPages, records: cleanedRecords }, taskPacketPath };
}

export async function lintLlmWiki(input: LlmWikiInput = {}): Promise<LlmWikiLintReport> {
  const root = resolve(input.root ?? process.cwd());
  const wikiPath = normalizeWikiPath(input.wikiPath);
  const wikiRoot = resolveWikiRoot(root, wikiPath);
  const issues: LlmWikiLintIssue[] = [];

  for (const path of ['SCHEMA.md', 'index.md', 'log.md', ...requiredDirectories]) {
    try {
      await stat(join(wikiRoot, path));
    } catch {
      issues.push({
        severity: path.includes('.') ? 'critical' : 'high',
        code: 'missing_required_path',
        path,
        message: `Required LLM Wiki path is missing: ${path}`,
      });
    }
  }

  const rawSources = await collectSourceFiles(join(wikiRoot, 'raw'));
  for (const rawSource of rawSources) {
    const rawRelative = relative(wikiRoot, rawSource).replaceAll('\\', '/');
    const content = await readFile(rawSource, 'utf8');
    const frontmatter = parseFrontmatter(content);
    if (!frontmatter) {
      issues.push({
        severity: 'high',
        code: 'raw_source_hash_mismatch',
        path: rawRelative,
        message: `Raw source is missing immutable source frontmatter: ${rawRelative}`,
      });
      continue;
    }
    const expectedHash = frontmatter.sha256;
    const currentHash = sha256(frontmatter.body);
    if (!expectedHash || expectedHash !== currentHash) {
      issues.push({
        severity: 'high',
        code: 'raw_source_hash_mismatch',
        path: rawRelative,
        message: `Raw source hash changed: ${rawRelative}`,
      });
    }
  }

  const index = await safeRead(join(wikiRoot, 'index.md'));
  const wikiPages = await collectWikiPages(wikiRoot);
  const existingPageSet = new Set([...wikiPages, ...rawSources.map((source) => relative(wikiRoot, source).replaceAll('\\', '/'))]);
  const inbound = new Map<string, number>();
  for (const page of wikiPages) inbound.set(page, index.includes(`[[${page}]]`) ? 1 : 0);

  for (const page of wikiPages) {
    const fullPath = join(wikiRoot, page);
    const content = await readFile(fullPath, 'utf8');
    const metadata = parsePageFrontmatter(content);
    if (!metadata) {
      issues.push({
        severity: 'high',
        code: 'missing_frontmatter',
        path: page,
        message: `Wiki page is missing required YAML frontmatter: ${page}`,
      });
    }
    if (!index.includes(`[[${page}]]`)) {
      issues.push({
        severity: 'medium',
        code: 'missing_index_entry',
        path: page,
        message: `Wiki page is missing from index.md: ${page}`,
      });
    }

    for (const link of extractWikiLinks(content)) {
      const target = resolveWikiLink(link, existingPageSet);
      if (!target) {
        issues.push({
          severity: 'high',
          code: 'broken_wikilink',
          path: page,
          message: `Broken wikilink [[${link}]] in ${page}`,
        });
      } else if (inbound.has(target)) {
        inbound.set(target, (inbound.get(target) ?? 0) + 1);
      }
    }
  }

  for (const [page, count] of inbound.entries()) {
    if (count === 0) {
      issues.push({
        severity: 'low',
        code: 'orphan_page',
        path: page,
        message: `Wiki page has no inbound links: ${page}`,
      });
    }
  }

  return { wikiPath, ok: issues.length === 0, issues };
}

async function collectSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const rootStat = await stat(root);
    if (rootStat.isFile()) return sourceExtensions.has(extname(root).toLowerCase()) ? [root] : [];
  } catch {
    return [];
  }

  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (entry.isFile() && sourceExtensions.has(extname(entry.name).toLowerCase())) {
        files.push(path);
      }
    }
  }

  await visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function normalizeWikiPath(path: string | undefined): string {
  const wikiPath = (path ?? defaultWikiPath).replaceAll('\\', '/').replace(/^\.\/+/, '');
  if (!wikiPath || wikiPath.includes('..') || isAbsolute(wikiPath)) {
    throw new Error(`Invalid LLM Wiki path: ${path ?? ''}`);
  }
  return wikiPath;
}

function resolveWikiRoot(root: string, wikiPath: string): string {
  return resolve(root, wikiPath);
}

function normalizeSourcePath(root: string, sourceFile: string): string {
  const sourcePath = relative(root, sourceFile).replaceAll('\\', '/');
  return sourcePath.startsWith('..') ? sourceFile : sourcePath;
}

function normalizeTaskRead(root: string, wikiRoot: string, wikiPath: string, sourceFile: string): string {
  const sourcePath = normalizeSourcePath(root, sourceFile);
  if (!sourcePath.startsWith('..') && !isAbsolute(sourcePath)) {
    if (sourcePath.startsWith(`${wikiPath}/`)) return sourcePath;
    const wikiRelative = relative(wikiRoot, sourceFile).replaceAll('\\', '/');
    if (!wikiRelative.startsWith('..')) return `${wikiPath}/${wikiRelative}`;
    return sourcePath;
  }
  const wikiRelative = relative(wikiRoot, sourceFile).replaceAll('\\', '/');
  return wikiRelative.startsWith('..') ? sourcePath : `${wikiPath}/${wikiRelative}`;
}

function instructionsForWikiTask(kind: LlmWikiTaskInput['kind']): string[] {
  const common = [
    'Use the current coding agent LLM capability to read, compare, and synthesize project knowledge; Kata binary does not call an LLM here.',
    'Treat generated pages as project-understanding candidates, not proof of code correctness.',
    'Preserve provenance with wikilinks to raw sources and concise frontmatter.',
    'Do not edit raw/ files manually; write synthesized pages under concepts/, entities/, comparisons/, or queries/.',
  ];
  if (kind === 'bootstrap') {
    return [
      ...common,
      'Bootstrap the first durable concepts and entities from the raw documentation set.',
      'Prefer stable architecture, workflow, naming, and constraint pages over broad summaries.',
    ];
  }
  if (kind === 'distill') {
    return [
      ...common,
      'Distill only knowledge supported by passed task artifacts, review findings, judge result, and evidence envelopes.',
      'Write concise knowledge candidates that future agents can reuse without re-reading the entire task history.',
    ];
  }
  return [
    ...common,
    'Enrich the Wiki by extracting stable concepts, entities, comparisons, project constraints, and recurring workflows from required reads.',
    'IMPORTANT: Design docs (raw/) are historical context — source code under packages/ is ground truth. Before writing a page, read actual source files (ports, domains, infrastructure, adapters) to verify each claim. If source and design doc disagree, source wins.',
    'Use CodeGraph (available via the codegraph_explore MCP tool or `kata codegraph explore/query/impact`) to navigate the codebase efficiently: find relevant source files, explore call paths, and verify claims against actual implementations.',
    'After writing pages, run the follow-up deterministic CLI commands and fix lint issues before handing off.',
  ];
}

function renderRawSource(sourcePath: string, body: string): string {
  return `---\nsource_path: ${sourcePath}\ningested: ${new Date().toISOString()}\nsha256: ${sha256(body)}\n---\n${body}`;
}

function renderSchema(now: string): string {
  return `# Project LLM Wiki Schema

Created: ${now}

## Domain

Project implementation knowledge for agentic coding workflows.

## Layers

- \`raw/\`: immutable source material copied from project documentation or curated external sources.
- \`entities/\`, \`concepts/\`, \`comparisons/\`, \`queries/\`: agent-maintained markdown synthesis.
- \`SCHEMA.md\`, \`index.md\`, and \`log.md\`: orientation files. Every agent must read them before wiki work.

## Rules

- Read \`SCHEMA.md\`, \`index.md\`, and recent \`log.md\` before ingesting, querying, or linting.
- Do not modify \`raw/\` files manually; re-ingest sources and preserve provenance.
- Use wikilinks for durable references.
- Update \`index.md\` and append \`log.md\` for every meaningful wiki action.
- Treat wiki content as project-understanding aid, not code-correctness proof.
`;
}

function renderIndex(importedSources: string[], now: string): string {
  const sourceLines = importedSources.map((source) => `- [[${source}]] — imported raw project documentation source.`).join('\n');
  return `# Wiki Index

> Content catalog for the project LLM Wiki.
> Last updated: ${now} | Total pages: 0 | Raw sources: ${importedSources.length}

## Entities

## Concepts

## Comparisons

## Queries

## Raw Sources

${sourceLines}
`;
}

function renderLog(importedSources: string[], now: string): string {
  const date = now.slice(0, 10);
  const sourceLines = importedSources.map((source) => `- ${source}`).join('\n');
  return `# Wiki Log

> Chronological record of all wiki actions. Append-only.
> Format: \`## [YYYY-MM-DD] action | subject\`

## [${date}] init | Project LLM Wiki initialized

- Imported sources: ${importedSources.length}
${sourceLines}
`;
}

function renderSummaryPage(input: { title: string; slug: string; recordId: string; rawSource: string; body: string }): string {
  const summary = oneLineSummary(input.body);
  return `---
title: ${input.title}
created: ${new Date().toISOString().slice(0, 10)}
updated: ${new Date().toISOString().slice(0, 10)}
type: concept
tags: [project, source]
sources: [${input.rawSource}]
confidence: medium
kata_record_id: ${input.recordId}
---

# ${input.title}

${summary}

## Source

- [[${input.rawSource}]]
`;
}

function renderQueryAnswer(query: string, matches: Array<{ page: string; content: string; score: number }>): string {
  if (matches.length === 0) return `No compiled LLM Wiki pages matched "${query}".`;
  const citations = matches.map((match) => `[[${match.page}]]`).join(' and ');
  const excerpts = matches.map((match) => firstMeaningfulLine(match.content)).filter(Boolean).join('\n\n');
  return `Based on ${citations}:\n\n${excerpts}`;
}

function renderQueryPage(query: string, answer: string, citations: string[]): string {
  const now = new Date().toISOString().slice(0, 10);
  return `---
title: ${query}
created: ${now}
updated: ${now}
type: query
tags: [query]
sources: [${citations.join(', ')}]
confidence: medium
---

# ${query}

${answer}
`;
}

function parseFrontmatter(content: string): { sha256?: string; body: string } | null {
  if (!content.startsWith('---\n')) return null;
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return null;
  const header = content.slice(4, end);
  const body = content.slice(end + '\n---\n'.length);
  const shaMatch = /^sha256:\s*([a-f0-9]{64})\s*$/m.exec(header);
  return { sha256: shaMatch?.[1], body };
}

function parsePageFrontmatter(content: string): Record<string, string> | null {
  if (!content.startsWith('---\n')) return null;
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return null;
  const header = content.slice(4, end);
  const required = ['title:', 'created:', 'updated:', 'type:', 'tags:', 'sources:'];
  return required.every((field) => header.includes(field)) ? { header } : null;
}

async function collectWikiPages(wikiRoot: string): Promise<string[]> {
  const pages: string[] = [];
  for (const directory of ['entities', 'concepts', 'comparisons', 'queries']) {
    const files = await collectSourceFiles(join(wikiRoot, directory));
    pages.push(...files.map((file) => relative(wikiRoot, file).replaceAll('\\', '/')));
  }
  return pages.sort();
}

async function upsertIndexEntry(wikiRoot: string, section: 'Concepts' | 'Queries', pagePath: string, summary: string): Promise<void> {
  const indexPath = join(wikiRoot, 'index.md');
  let index = await readFile(indexPath, 'utf8');
  const entry = `- [[${pagePath}]] — ${summary}`;
  if (index.includes(`[[${pagePath}]]`)) return;
  const heading = `## ${section}`;
  const headingIndex = index.indexOf(heading);
  if (headingIndex === -1) {
    index += `\n${heading}\n\n${entry}\n`;
  } else {
    const insertAt = index.indexOf('\n## ', headingIndex + heading.length);
    const prefix = insertAt === -1 ? index.trimEnd() : index.slice(0, insertAt).trimEnd();
    const suffix = insertAt === -1 ? '' : index.slice(insertAt);
    index = `${prefix}\n\n${entry}\n${suffix}`;
  }
  await writeFile(indexPath, index, 'utf8');
}

async function appendLog(wikiRoot: string, subject: string, lines: string[]): Promise<void> {
  const logPath = join(wikiRoot, 'log.md');
  const existing = await readFile(logPath, 'utf8');
  const date = new Date().toISOString().slice(0, 10);
  await writeFile(logPath, `${existing.trimEnd()}\n\n## [${date}] ${subject}\n\n${lines.join('\n')}\n`, 'utf8');
}

async function safeRead(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

function extractWikiLinks(content: string): string[] {
  return [...content.matchAll(/\[\[([^\]]+)\]\]/g)].map((match) => match[1].split('|')[0].trim());
}

function resolveWikiLink(link: string, existingPages: Set<string>): string | null {
  const normalized = link.replaceAll('\\', '/').replace(/^\.\/+/, '');
  const candidates = [normalized, `${normalized}.md`];
  for (const candidate of candidates) {
    if (existingPages.has(candidate)) return candidate;
  }
  const basename = normalized.split('/').pop();
  if (!basename) return null;
  for (const page of existingPages) {
    if (page === basename || page.endsWith(`/${basename}`) || page.endsWith(`/${basename}.md`)) return page;
  }
  return null;
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'untitled';
}

function titleFromMarkdown(body: string): string | null {
  const heading = /^#\s+(.+)$/m.exec(body);
  return heading?.[1].trim() ?? null;
}

function titleFromSlug(slug: string): string {
  return slug.split('-').filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ') || 'Untitled';
}

function oneLineSummary(body: string): string {
  return firstMeaningfulLine(body).replace(/^#+\s*/, '').slice(0, 160) || 'Imported project knowledge source.';
}

function firstMeaningfulLine(body: string): string {
  return body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('---')) ?? '';
}

function scoreContent(query: string, content: string, path: string): number {
  const haystack = `${path}\n${content}`.toLowerCase();
  const terms = query.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter((term) => term.length >= 2);
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
