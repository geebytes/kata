import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { evidenceKinds, type EvidenceKind } from '../quality/evidence.js';
import { projectConfigPath } from './layout.js';

export type ResponseLanguage = 'en' | 'zh';

export type KataConfig = {
  language?: ResponseLanguage;
  quality?: {
    /** Whether installed documentation (AGENTS.md, `.agents/skills/**`) may define the seal gate. Defaults to true. */
    discoverChecks?: boolean;
    buildChecks?: Array<{
      id?: string;
      name?: string;
      kind?: EvidenceKind;
      command: string;
      args?: string[];
      timeoutMs?: number;
      /**
       * When this check runs.
       *
       * `seal` (the default) runs on every seal; `frozen` is for the expensive whole-project verification a project
       * wants at the point the artefact is frozen (judge/archive) rather than on every seal. Nothing is deferred
       * unless a project says so — the default keeps every check running exactly where it ran before — and a deferred
       * check is always named in the seal's report.
       */
      tier?: CheckTier;
    }>;
  };
};

/** When a declared check runs: every seal, or only when the artefact is frozen. */
export type CheckTier = 'seal' | 'frozen';

export async function loadConfig(root: string): Promise<KataConfig> {
  const parsed = await readConfigObject(root);

  try {
    return {
      ...(parsed.language !== undefined ? { language: parseResponseLanguage(parsed.language) } : {}),
      ...(isRecord(parsed.quality) ? { quality: parseQualityConfig(parsed.quality) } : {}),
    };
  } catch (error) {
    throw new Error(`Invalid Kata config: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function readConfigObject(root: string): Promise<Record<string, unknown>> {
  const configPath = projectConfigPath(root);
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return {};
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid Kata config JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isRecord(parsed)) throw new Error('Invalid Kata config: root must be an object');
  return parsed;
}

export async function writeConfigPatch(root: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const current = await readConfigObject(root);
  const next = { ...current, ...patch };
  await writeFile(projectConfigPath(root), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

function parseQualityConfig(value: Record<string, unknown>): KataConfig['quality'] {
  const buildChecks = Array.isArray(value.buildChecks)
    ? value.buildChecks.map(parseQualityCheck)
    : undefined;
  const discoverChecks = typeof value.discoverChecks === 'boolean' ? value.discoverChecks : undefined;
  return {
    ...(buildChecks ? { buildChecks } : {}),
    ...(discoverChecks !== undefined ? { discoverChecks } : {}),
  };
}

function parseQualityCheck(value: unknown): NonNullable<NonNullable<KataConfig['quality']>['buildChecks']>[number] {
  if (!isRecord(value)) throw new Error('quality.buildChecks entries must be objects');
  if (typeof value.command !== 'string' || value.command.length === 0) {
    throw new Error('quality.buildChecks[].command is required');
  }
  const args = value.args === undefined
    ? undefined
    : Array.isArray(value.args) && value.args.every((item) => typeof item === 'string')
      ? value.args
      : (() => { throw new Error('quality.buildChecks[].args must be a string array'); })();
  const kind = value.kind === undefined
    ? undefined
    : isEvidenceKind(value.kind)
      ? value.kind
      : (() => { throw new Error('quality.buildChecks[].kind is invalid'); })();
  const tier = value.tier === undefined
    ? undefined
    : value.tier === 'seal' || value.tier === 'frozen'
      ? value.tier
      : (() => { throw new Error('quality.buildChecks[].tier must be "seal" or "frozen"'); })();
  return {
    ...(typeof value.id === 'string' ? { id: value.id } : {}),
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...(kind ? { kind } : {}),
    ...(tier ? { tier } : {}),
    command: value.command,
    ...(args ? { args } : {}),
    ...(typeof value.timeoutMs === 'number' ? { timeoutMs: value.timeoutMs } : {}),
  };
}

function isEvidenceKind(value: unknown): value is EvidenceKind {
  return typeof value === 'string' && (evidenceKinds as readonly string[]).includes(value);
}

function parseResponseLanguage(value: unknown): ResponseLanguage {
  if (value === 'en' || value === 'zh') return value;
  throw new Error('language must be "en" or "zh"');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
