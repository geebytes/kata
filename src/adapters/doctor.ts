import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { skillCommands, type InstallOptions, type InstallScope, type Platform } from './manifest.js';
import { installationRoot, sha256 } from './ownership.js';
import { platformCommandPath, platformDefinitionById, platformRulePath, platformSkillPath, platformSkillsDir } from './platforms.js';

export type DoctorStatus = 'ok' | 'missing' | 'conflict' | 'skipped';

export type DoctorCheck = {
  path: string;
  kind: 'skill' | 'rule' | 'hook' | 'command' | 'support' | 'wiki';
  status: DoctorStatus;
  reason?: string;
};

export type DoctorReport = {
  command: 'doctor';
  platform: Platform;
  scope: InstallScope;
  root: string;
  ok: boolean;
  checks: DoctorCheck[];
  summary: { ok: number; missing: number; conflicts: number; skipped: number };
};

type OwnershipManifest = {
  files?: Record<string, { sha256?: string }>;
};

export async function doctor(
  platform: Platform,
  scope: InstallScope,
  options: InstallOptions = {},
): Promise<DoctorReport> {
  const root = installationRoot(scope, options);
  const manifest = await readOwnershipManifest(root);
  const checks: DoctorCheck[] = [];

  for (const command of skillCommands) {
    checks.push(await checkPath(root, manifest, platformSkillPath(platform, scope, command.id), 'skill'));
    const commandPath = platformCommandPath(platform, scope, command.id);
    if (commandPath) checks.push(await checkPath(root, manifest, commandPath, 'command'));
  }

  const rulePath = platformRulePath(platform, scope, 'kata-agent-contract');
  if (rulePath) checks.push(await checkPath(root, manifest, rulePath, 'rule'));

  const definition = platformDefinitionById[platform];
  if (definition.hookFormat) {
    const base = platformSkillsDir(platform, scope);
    checks.push(await checkPath(root, manifest, `${base}/hooks/kata-hook-guard.mjs`, 'hook'));
    const hookConfigPath = hookConfigPathFor(platform, scope);
    if (hookConfigPath) checks.push(await checkPath(root, manifest, hookConfigPath, 'hook'));
  }

  if (scope === 'project') {
    checks.push(await checkPath(root, manifest, 'AGENTS.md', 'support'));
    checks.push(await checkPath(root, manifest, '.kata/skills-index.md', 'support'));
    checks.push(await checkExists(root, '.llmwiki', 'wiki'));
  }

  const summary = summarize(checks);
  return {
    command: 'doctor',
    platform,
    scope,
    root,
    ok: summary.missing === 0 && summary.conflicts === 0,
    checks,
    summary,
  };
}

function hookConfigPathFor(platform: Platform, scope: InstallScope): string | null {
  const base = platformSkillsDir(platform, scope);
  const format = platformDefinitionById[platform].hookFormat;
  if (format === 'claude-code') return `${base}/settings.local.json`;
  if (format === 'gemini') return `${base}/settings.json`;
  if (format === 'windsurf') return `${base}/hooks.json`;
  if (format === 'copilot') return `${base}/hooks/kata-guard.json`;
  return null;
}

async function checkPath(
  root: string,
  manifest: OwnershipManifest,
  relativePath: string,
  kind: DoctorCheck['kind'],
): Promise<DoctorCheck> {
  const content = await readOptional(join(root, relativePath));
  if (content === undefined) return { path: relativePath, kind, status: 'missing' };
  const owned = manifest.files?.[relativePath];
  if (owned?.sha256 && owned.sha256 !== sha256(content)) {
    return { path: relativePath, kind, status: 'conflict', reason: 'content differs from ownership manifest' };
  }
  return { path: relativePath, kind, status: 'ok' };
}

async function checkExists(root: string, relativePath: string, kind: DoctorCheck['kind']): Promise<DoctorCheck> {
  try {
    await stat(join(root, relativePath));
    return { path: relativePath, kind, status: 'ok' };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { path: relativePath, kind, status: 'missing' };
    throw error;
  }
}

async function readOwnershipManifest(root: string): Promise<OwnershipManifest> {
  const content = await readOptional(join(root, '.kata/adapters/manifest.json'));
  if (!content) return {};
  try {
    return JSON.parse(content) as OwnershipManifest;
  } catch {
    return {};
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function summarize(checks: DoctorCheck[]): { ok: number; missing: number; conflicts: number; skipped: number } {
  const summary = { ok: 0, missing: 0, conflicts: 0, skipped: 0 };
  for (const check of checks) {
    if (check.status === 'conflict') summary.conflicts += 1;
    else summary[check.status] += 1;
  }
  return summary;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
