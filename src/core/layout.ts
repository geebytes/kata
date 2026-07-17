import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { cwd } from 'node:process';
import { accessSync } from 'node:fs';
import { loadConfig } from './config.js';

export type LayoutResult = {
  created: string[];
  existing: string[];
  conflicts: string[];
};

const layoutDirectories = [
  '.kata',
  '.kata/rules',
  '.kata/wiki',
  '.kata/tasks',
  '.kata/evidence',
  '.kata/schemas',
  '.kata/runtime',
] as const;

const schemaFiles = [
  'task.schema.json',
  'workflow-state-record.schema.json',
  'workflow-state-event.schema.json',
  'evidence.schema.json',
  'review-finding.schema.json',
  'judge-result.schema.json',
  'wiki-record.schema.json',
  'handoff-packet.schema.json',
  'handoff-receipt.schema.json',
] as const;

const schemaManifestFile = '.generated-schemas.json';

type SchemaManifest = {
  version: 1;
  files: Record<string, { sha256: string }>;
};

function hasFileOrDir(dir: string, name: string): boolean {
  try {
    accessSync(join(dir, name));
    return true;
  } catch {
    return false;
  }
}

const workspaceMarkers = ['.git', '.opencode', 'opencode.json', 'package.json', 'Cargo.toml', 'go.mod'];

export function resolveWorkspaceRoot(from?: string): string {
  let dir = resolve(from ?? cwd());
  while (true) {
    for (const marker of workspaceMarkers) {
      if (hasFileOrDir(dir, marker)) return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) return from ?? cwd();
    dir = parent;
  }
}

export async function initLayout(root: string): Promise<LayoutResult> {
  await loadConfig(root);

  const result: LayoutResult = { created: [], existing: [], conflicts: [] };

  for (const relativePath of layoutDirectories) {
    const absolutePath = join(root, relativePath);
    try {
      const entry = await stat(absolutePath);
      if (entry.isDirectory()) result.existing.push(relativePath);
      else result.conflicts.push(relativePath);
    } catch (error) {
      if (!isNodeError(error) || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) throw error;
      if (error.code === 'ENOTDIR') {
        result.conflicts.push(relativePath);
        continue;
      }
      await mkdir(absolutePath);
      result.created.push(relativePath);
    }
  }

  if (result.conflicts.length === 0) {
    await installSchemaCopies(root, result);
    await ensureRuntimeGitignore(root);
  }

  return result;
}

async function installSchemaCopies(root: string, result: LayoutResult): Promise<void> {
  const targetDirectory = join(root, '.kata/schemas');
  const manifest = await readSchemaManifest(targetDirectory, result);
  if (manifest === undefined) return;

  let manifestChanged = false;
  for (const schemaFile of schemaFiles) {
    const sourceUrl = new URL(`../../schemas/${schemaFile}`, import.meta.url);
    const target = join(targetDirectory, schemaFile);
    const content = await readFile(sourceUrl, 'utf8');
    const generatedHash = sha256(content);
    const recordedHash = manifest.files[schemaFile]?.sha256;

    try {
      const existingContent = await readFile(target, 'utf8');
      const existingHash = sha256(existingContent);
      if (recordedHash === undefined) {
        result.conflicts.push(`.kata/schemas/${schemaFile}`);
        continue;
      }
      if (existingHash !== recordedHash && existingHash !== generatedHash) {
        result.conflicts.push(`.kata/schemas/${schemaFile}`);
        continue;
      }
      if (existingHash !== generatedHash) {
        await writeFileAtomic(target, content);
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
      await writeFileAtomic(target, content);
    }

    if (recordedHash !== generatedHash) {
      manifest.files[schemaFile] = { sha256: generatedHash };
      manifestChanged = true;
    }
  }

  if (manifestChanged) {
    await writeFileAtomic(join(targetDirectory, schemaManifestFile), `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

async function readSchemaManifest(
  targetDirectory: string,
  result: LayoutResult,
): Promise<SchemaManifest | undefined> {
  const manifestPath = join(targetDirectory, schemaManifestFile);
  try {
    const content = await readFile(manifestPath, 'utf8');
    const parsed = JSON.parse(content) as unknown;
    if (!isSchemaManifest(parsed)) {
      result.conflicts.push(`.kata/schemas/${schemaManifestFile}`);
      return undefined;
    }
    return parsed;
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
    return { version: 1, files: {} };
  }
}

function isSchemaManifest(value: unknown): value is SchemaManifest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { version?: unknown; files?: unknown };
  if (candidate.version !== 1 || typeof candidate.files !== 'object' || candidate.files === null) return false;
  return Object.values(candidate.files).every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const candidateEntry = entry as { sha256?: unknown };
    return typeof candidateEntry.sha256 === 'string' && /^[a-f0-9]{64}$/.test(candidateEntry.sha256);
  });
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function ensureRuntimeGitignore(root: string): Promise<void> {
  const gitignorePath = join(root, '.gitignore');
  let content = '';
  try {
    content = await readFile(gitignorePath, 'utf8');
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
  }

  const entry = '.kata/runtime/';
  const lines = content.split(/\r?\n/);
  if (lines.includes(entry)) return;

  const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  await writeFileAtomic(gitignorePath, `${content}${separator}${entry}\n`);
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, content, 'utf8');
  await rename(temporaryPath, path);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
