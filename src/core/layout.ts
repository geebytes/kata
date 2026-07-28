import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { cwd } from 'node:process';
import { accessSync, readdirSync, type Dirent } from 'node:fs';
import { loadConfig } from './config.js';
import taskSchema from 'kata-asset:schemas/task.schema.json';
import workflowStateRecordSchema from 'kata-asset:schemas/workflow-state-record.schema.json';
import workflowStateEventSchema from 'kata-asset:schemas/workflow-state-event.schema.json';
import evidenceSchema from 'kata-asset:schemas/evidence.schema.json';
import reviewFindingSchema from 'kata-asset:schemas/review-finding.schema.json';
import judgeResultSchema from 'kata-asset:schemas/judge-result.schema.json';
import wikiRecordSchema from 'kata-asset:schemas/wiki-record.schema.json';
import handoffPacketSchema from 'kata-asset:schemas/handoff-packet.schema.json';
import handoffReceiptSchema from 'kata-asset:schemas/handoff-receipt.schema.json';

const schemaContents: Record<string, string> = {
  'task.schema.json': taskSchema,
  'workflow-state-record.schema.json': workflowStateRecordSchema,
  'workflow-state-event.schema.json': workflowStateEventSchema,
  'evidence.schema.json': evidenceSchema,
  'review-finding.schema.json': reviewFindingSchema,
  'judge-result.schema.json': judgeResultSchema,
  'wiki-record.schema.json': wikiRecordSchema,
  'handoff-packet.schema.json': handoffPacketSchema,
  'handoff-receipt.schema.json': handoffReceiptSchema,
};

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

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'target',
  'dist',
  'build',
  '.kata',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.env',
  '.opencode',
]);

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

/**
 * Resolve the repository that owns an explicitly named Kata task.
 *
 * A generic workspace marker (especially a nested `.git`) is insufficient for
 * workflow mutation: it can silently select a different `.kata` state tree.
 * Task-addressed commands therefore search ancestor directories for the task
 * itself and reject ambiguous ownership rather than guessing.
 *
 * Resolution order:
 * 1. Search ancestor directories from the starting path upward.
 * 2. If no ancestor owns the task, search descendant directories beneath the
 *    workspace root, skipping dependency, metadata, and Kata-internal dirs.
 * 3. A single result wins; multiple results fail closed.
 */
export function resolveWorkspaceRootForTask(taskId: string, from?: string): string {
  const start = resolve(from ?? cwd());
  const candidates: string[] = [];
  let directory = start;
  while (true) {
    if (hasFileOrDir(directory, join('.kata', 'tasks', taskId, 'current-state.json'))) {
      candidates.push(directory);
    }
    const parent = resolve(directory, '..');
    if (parent === directory) break;
    directory = parent;
  }
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    throw new Error(`Ambiguous Kata task root for ${taskId}: ${candidates.join(', ')}. Pass --root explicitly.`);
  }

  const workspaceRoot = resolveWorkspaceRoot(start);
  const descendants = findDescendantTaskRoots(taskId, workspaceRoot);

  if (descendants.length === 1) return descendants[0]!;
  if (descendants.length > 1) {
    throw new Error(
      `Multiple descendant worktrees own task ${taskId}: ${descendants.join(', ')}. Pass --root explicitly to select one.`,
    );
  }

  throw new Error(
    `No Kata workspace owns task ${taskId}. Neither the current/ancestor workspace nor any eligible nested worktree contains this task. Pass --root explicitly or run the command from that workspace.`,
  );
}

function findDescendantTaskRoots(taskId: string, root: string): string[] {
  const candidates: string[] = [];

  function scan(dir: string): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = join(dir, entry.name);
      if (hasFileOrDir(fullPath, join('.kata', 'tasks', taskId, 'current-state.json'))) {
        candidates.push(fullPath);
      }
      scan(fullPath);
    }
  }

  scan(root);
  return candidates;
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
    const target = join(targetDirectory, schemaFile);
    const content = schemaContents[schemaFile];
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
