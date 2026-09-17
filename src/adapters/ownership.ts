import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { loadConfig, writeConfigPatch } from '../core/config.js';
import { initLlmWiki, buildLlmWikiTask } from '../wiki/llmwiki.js';
import {
  commandManifest,
  renderSkill,
  skillCommands,
  type InstallOptions,
  type InstallReport,
  type InstallScope,
  type Platform,
} from './manifest.js';
import { platformCommandPath, platformConfigDir, platformDefinitionById, platformRulePath, platformSkillPath, resolvePlatformGlobalDir } from './platforms.js';
import { renderHookGuardScript } from '../policy/guard-script.js';
import { hookConfigForPlatform, mergeHookConfig, removeManagedHookConfig } from './hook-configs.js';

// The guard asset lives beside the policy it encodes; re-exported here for callers that know the installer by its path.
export { renderHookGuardScript };
import { hashContent } from '../core/hash.js';
import { adaptersManifestPath, skillsIndexRelativePath, taskDir as layoutTaskDir } from '../core/layout.js';

type OwnedFile = {
  platform: Platform;
  scope: InstallScope;
  commandId: string;
  path: string;
  sha256: string;
};

type OwnershipManifest = {
  version: 1;
  commandManifest: typeof commandManifest;
  files: Record<string, OwnedFile>;
};

export async function install(platform: Platform, scope: InstallScope, options: InstallOptions = {}): Promise<InstallReport> {
  const effective = await resolveGlobalInstallRoot(platform, scope, options);
  return writeSkills(platform, scope, effective);
}

export async function update(platform: Platform, scope: InstallScope, options: InstallOptions = {}): Promise<InstallReport> {
  const initializedScope = await resolveInitializedScope(platform, scope, options);
  const effective = await resolveGlobalInstallRoot(platform, initializedScope, options);
  return writeSkills(platform, initializedScope, effective);
}

/**
 * Global-scope installs honour the platform's env-var config dir (CODEX_HOME
 * etc.) before falling back to $HOME. Without this, `kata-cli init --scope
 * global` writes to $HOME/.codex even when CODEX_HOME points elsewhere.
 */
async function resolveGlobalInstallRoot(
  platform: Platform,
  scope: InstallScope,
  options: InstallOptions,
): Promise<InstallOptions> {
  if (scope !== 'global' || options.home) return options;
  const envDir = resolvePlatformGlobalDir(platform);
  if (envDir) return { ...options, home: envDir };
  return options;
}

export async function listManagedPlatforms(
  scope: InstallScope,
  options: InstallOptions = {},
): Promise<Platform[]> {
  const manifest = await readManifest(manifestBaseRoot(scope, options));
  return [...new Set(
    Object.values(manifest.files)
      .filter((file) => file.scope === scope)
      .map((file) => file.platform),
  )].sort();
}

export async function uninstall(
  platform: Platform,
  scope: InstallScope,
  options: InstallOptions = {},
): Promise<InstallReport> {
  const effective = await resolveGlobalInstallRoot(platform, scope, options);
  const baseRoot = installationRoot(scope, effective);
  const manifestRoot = manifestBaseRoot(scope, effective);
  const manifest = await readManifest(manifestRoot);
  const report = createReport(platform, scope, options.dryRun === true);
  const entries = Object.values(manifest.files).filter((file) => file.platform === platform && file.scope === scope);

  for (const entry of entries) {
    report.planned.push(entry.path);
    const absolutePath = join(baseRoot, entry.path);
    const current = await readOptional(absolutePath);
    if (current === undefined) {
      delete manifest.files[entry.path];
      continue;
    }
    const currentHash = sha256(current);
    if (!options.force && currentHash !== entry.sha256) {
      report.conflicts.push(entry.path);
      continue;
    }
    if (!options.dryRun) {
      if (entry.commandId === 'project-contract' && entry.path === 'AGENTS.md') {
        const nextContent = removeAgentsContract(current);
        if (nextContent.trim().length > 0) {
          await writeFileAtomic(absolutePath, nextContent);
        } else {
          await rm(absolutePath);
        }
      } else if (entry.commandId.startsWith('hook-config:')) {
        const nextContent = removeManagedHookConfig(current, entry.commandId);
        if (nextContent.trim().length > 0) {
          await writeFileAtomic(absolutePath, nextContent);
        } else {
          await rm(absolutePath);
        }
      } else {
        await rm(absolutePath);
      }
      delete manifest.files[entry.path];
    }
    report.removed.push(entry.path);
  }

  if (!options.dryRun) await writeManifest(manifestRoot, manifest);
  return report;
}

async function writeSkills(
  platform: Platform,
  scope: InstallScope,
  options: InstallOptions,
): Promise<InstallReport> {
  const effectiveOptions = await resolveEffectiveInstallOptions(scope, options);
  const baseRoot = installationRoot(scope, effectiveOptions);
  const manifestRoot = manifestBaseRoot(scope, effectiveOptions);
  const manifest = await readManifest(manifestRoot);
  const report = createReport(platform, scope, effectiveOptions.dryRun === true);

  for (const command of skillCommands) {
    const relativePath = platformSkillPath(platform, scope, command.id, baseRoot);
    const absolutePath = join(baseRoot, relativePath);
    const content = renderSkill(command, platform, { language: effectiveOptions.language });
    const nextHash = sha256(content);
    const previous = manifest.files[relativePath];

    report.planned.push(relativePath);
    const existing = await readOptional(absolutePath);
    if (existing !== undefined) {
      const existingHash = sha256(existing);
      if (previous === undefined && !effectiveOptions.force) {
        report.conflicts.push(relativePath);
        continue;
      }
      if (previous !== undefined && existingHash !== previous.sha256 && existingHash !== nextHash && !effectiveOptions.force) {
        report.conflicts.push(relativePath);
        continue;
      }
      if (existingHash === nextHash) {
        report.unchanged.push(relativePath);
        manifest.files[relativePath] = ownedFile(platform, scope, command.id, relativePath, nextHash);
        continue;
      }
    }

    if (!effectiveOptions.dryRun) {
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFileAtomic(absolutePath, content);
      manifest.files[relativePath] = ownedFile(platform, scope, command.id, relativePath, nextHash);
      report.written.push(relativePath);
    }
  }

  await writePlatformAdapterFiles(platform, scope, effectiveOptions, baseRoot, manifest, report);
  await writePlatformHookFiles(platform, scope, effectiveOptions, baseRoot, manifest, report);
  await removeObsoleteCommandFiles(platform, scope, effectiveOptions, baseRoot, manifest, report);

  if (scope === 'project') {
    await writeProjectContractFiles(platform, scope, effectiveOptions, baseRoot, manifest, report);
    await manageProjectWiki(effectiveOptions, baseRoot, report);
  }

  if (!effectiveOptions.dryRun) await writeManifest(manifestRoot, manifest);
  return report;
}

async function resolveInitializedScope(
  platform: Platform,
  requestedScope: InstallScope,
  options: InstallOptions,
): Promise<InstallScope> {
  if (requestedScope === 'global') return requestedScope;

  const requestedManifest = await readManifest(manifestBaseRoot(requestedScope, options));
  if (manifestOwnsPlatform(requestedManifest, platform, requestedScope)) return requestedScope;

  const alternateScope: InstallScope = requestedScope === 'project' ? 'global' : 'project';
  const alternateManifest = await readManifest(manifestBaseRoot(alternateScope, options));
  return manifestOwnsPlatform(alternateManifest, platform, alternateScope) ? alternateScope : requestedScope;
}

function manifestOwnsPlatform(manifest: OwnershipManifest, platform: Platform, scope: InstallScope): boolean {
  return Object.values(manifest.files).some((file) => file.platform === platform && file.scope === scope);
}

async function removeObsoleteCommandFiles(
  platform: Platform,
  scope: InstallScope,
  options: InstallOptions,
  baseRoot: string,
  manifest: OwnershipManifest,
  report: InstallReport,
): Promise<void> {
  const activeCommands = new Set(skillCommands.map((command) => command.id));
  const obsolete = Object.values(manifest.files).filter((file) => {
    if (file.platform !== platform || file.scope !== scope) return false;
    const commandId = file.commandId.startsWith('command:') ? file.commandId.slice('command:'.length) : file.commandId;
    const isCommandArtifact = commandId.startsWith('kata-');
    return isCommandArtifact && !activeCommands.has(commandId as typeof skillCommands[number]['id']);
  });
  for (const file of obsolete) {
    const path = join(baseRoot, file.path);
    const current = await readOptional(path);
    if (current !== undefined && sha256(current) !== file.sha256 && !options.force) {
      report.conflicts.push(file.path);
      continue;
    }
    report.planned.push(file.path);
    if (!options.dryRun && current !== undefined) await rm(path);
    if (!options.dryRun) delete manifest.files[file.path];
    report.removed.push(file.path);
  }
}

async function resolveEffectiveInstallOptions(scope: InstallScope, options: InstallOptions): Promise<InstallOptions> {
  if (scope !== 'project') return options;

  const root = installationRoot(scope, options);
  const config = await loadConfig(root);
  const language = options.language ?? config.language;

  if (options.language && !options.dryRun) {
    await writeConfigPatch(root, { language: options.language });
  }

  return language === options.language ? options : { ...options, ...(language ? { language } : {}) };
}

async function writePlatformHookFiles(
  platform: Platform,
  scope: InstallScope,
  options: InstallOptions,
  baseRoot: string,
  manifest: OwnershipManifest,
  report: InstallReport,
): Promise<void> {
  const definition = platformDefinitionById[platform];
  if (!definition.hookFormat) return;

  const hookScriptPath = [platformConfigDir(platform, scope, baseRoot), 'hooks', 'kata-hook-guard.mjs'].filter(Boolean).join('/');
  await writeSupportFile({
    platform,
    scope,
    options,
    baseRoot,
    manifest,
    report,
    commandId: 'hook-script:kata-hook-guard',
    relativePath: hookScriptPath,
    content: renderHookGuardScript(),
  });

  const command = `node "${hookScriptPath}" --project-root "${baseRoot.replaceAll('"', '\\"')}"`;
  const config = hookConfigForPlatform(platform, scope, baseRoot);
  if (!config) return;

  await writeSupportFile({
    platform,
    scope,
    options,
    baseRoot,
    manifest,
    report,
    commandId: `hook-config:${definition.hookFormat}`,
    relativePath: config.relativePath,
    content: config.render(command),
    mergeExisting: (existing, block) => mergeHookConfig(existing, block, definition.hookFormat!),
  });
}

async function writePlatformAdapterFiles(
  platform: Platform,
  scope: InstallScope,
  options: InstallOptions,
  baseRoot: string,
  manifest: OwnershipManifest,
  report: InstallReport,
): Promise<void> {
  for (const command of skillCommands) {
    const relativePath = platformCommandPath(platform, scope, command.id, baseRoot);
    if (!relativePath) continue;
    await writeSupportFile({
      platform,
      scope,
      options,
      baseRoot,
      manifest,
      report,
      commandId: `command:${command.id}`,
      relativePath,
      content: renderOpenCodeCommand(command, options.language),
    });
  }

  const rulePath = platformRulePath(platform, scope, 'kata-agent-contract', baseRoot);
  if (!rulePath) return;
  await writeSupportFile({
    platform,
    scope,
    options,
    baseRoot,
    manifest,
    report,
    commandId: 'rule:kata-agent-contract',
    relativePath: rulePath,
    content: renderPlatformRule(platform, options.language),
  });
}

async function manageProjectWiki(options: InstallOptions, root: string, report: InstallReport): Promise<void> {
  if (options.noWiki) {
    report.wiki = { status: 'skipped', reason: 'disabled' };
    return;
  }

  const wikiExists = await pathExists(join(root, '.llmwiki'));

  if (wikiExists) {
    report.wiki = { status: 'existing', path: '.llmwiki' };
  } else {
    const from = options.wikiFrom ?? 'docs';
    const fromPath = join(root, from);
    if (!(await pathExists(fromPath))) {
      report.wiki = { status: 'skipped', reason: 'source_not_found', from };
      return;
    }

    if (options.dryRun) {
      report.wiki = { status: 'planned', path: '.llmwiki', from };
      return;
    }

    const result = await initLlmWiki({ root, from });
    report.wiki = {
      status: 'initialized',
      path: result.wikiPath,
      from,
      importedCount: result.importedSources.length,
    };
  }

  const enrichTask = await buildLlmWikiTask({ root, kind: 'enrich' });
  const taskDir = layoutTaskDir(root, 'wiki-enrich');
  await mkdir(taskDir, { recursive: true });
  await writeFile(join(taskDir, 'task-packet.json'), `${JSON.stringify(enrichTask, null, 2)}\n`);
}

async function writeProjectContractFiles(
  platform: Platform,
  scope: InstallScope,
  options: InstallOptions,
  baseRoot: string,
  manifest: OwnershipManifest,
  report: InstallReport,
): Promise<void> {
  await writeSupportFile({
    platform,
    scope,
    options,
    baseRoot,
    manifest,
    report,
    commandId: 'project-contract',
    relativePath: 'AGENTS.md',
    content: renderAgentsContract(options.language),
    mergeExisting: mergeAgentsContract,
  });
  await writeSupportFile({
    platform,
    scope,
    options,
    baseRoot,
    manifest,
    report,
    commandId: 'skills-index',
    relativePath: skillsIndexRelativePath,
    content: renderSkillsIndex(options.language),
  });
}

async function writeSupportFile(input: {
  platform: Platform;
  scope: InstallScope;
  options: InstallOptions;
  baseRoot: string;
  manifest: OwnershipManifest;
  report: InstallReport;
  commandId: string;
  relativePath: string;
  content: string;
  mergeExisting?: (existing: string, block: string) => string;
}): Promise<void> {
  const absolutePath = join(input.baseRoot, input.relativePath);
  const existing = await readOptional(absolutePath);
  const content = existing !== undefined && input.mergeExisting ? input.mergeExisting(existing, input.content) : input.content;
  const nextHash = sha256(content);
  const previous = input.manifest.files[input.relativePath];
  input.report.planned.push(input.relativePath);

  if (existing !== undefined) {
    const existingHash = sha256(existing);
    if (existingHash === nextHash) {
      input.report.unchanged.push(input.relativePath);
      input.manifest.files[input.relativePath] = ownedFile(input.platform, input.scope, input.commandId, input.relativePath, nextHash);
      return;
    }
    if (previous !== undefined && existingHash !== previous.sha256 && !input.options.force) {
      input.report.conflicts.push(input.relativePath);
      return;
    }
  }

  if (!input.options.dryRun) {
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFileAtomic(absolutePath, content);
    input.manifest.files[input.relativePath] = ownedFile(input.platform, input.scope, input.commandId, input.relativePath, nextHash);
    input.report.written.push(input.relativePath);
  }
}

function renderAgentsContract(language?: 'en' | 'zh'): string {
  const responseLanguage = renderResponseLanguageContract(language);
  return `<!-- STRATA:BEGIN -->
# Kata Agent Contract

Before non-trivial work in this project:

1. Run \`kata-cli orient --change <id> --role <role> --task-kind <kind>\`.
2. Read AGENTS.md plus the returned \`.llmwiki/SCHEMA.md\`, \`.llmwiki/index.md\`, and \`.llmwiki/log.md\` entries when present.
3. Use the matching \`/kata-*\` skill and follow its startup checklist.
4. Kata 不配置、不路由也不记录宿主平台模型。若需切换，请直接使用宿主平台自己的模型选择器或配置后继续。
5. Do not treat Wiki as proof of code correctness: CI, tests, Reviewer, and Judge own correctness.

## Development constraint: skill-first

For Kata development and dogfooding, the \`/kata-*\` skill is the human-facing workflow entrypoint. The \`kata-cli ...\` CLI is the deterministic execution layer used inside skills and scripts.

- Prefer short skill invocations such as \`/kata-build <intent>\`, \`/kata-review\`, \`/kata-collect\`, or \`继续\`.
- A skill must first discover the active/same-branch task with \`kata-cli status\`, follow relation redirects, and read \`nextAction\`.
- Do not ask the user to provide CLI flags such as \`--change\`, \`--role\`, or \`--task-kind\` unless discovery leaves multiple plausible choices.
- At \`review_gate\` and \`judge_gate\`, stop so the user can use the host platform's own model selector before continuing. At \`archive_gate\`, stop for the user's archive decision.
- Use CLI commands directly only for non-interactive automation, tests, CI, or when the host platform cannot execute slash-command skills.

Protected Kata paths and phase gates are enforced by the CLI.
${responseLanguage ? `\n${responseLanguage}` : ''}
<!-- STRATA:END -->
`;
}

function renderOpenCodeCommand(command: (typeof skillCommands)[number], language?: 'en' | 'zh'): string {
  const body = stripSkillFrontmatter(renderSkill(command, 'opencode', { language }));
  return `---
description: Run the ${command.id} Kata workflow
---

Equivalent Kata skill: \`${command.id}\`
Command name: \`${command.slashCommand}\`

Use the invocation arguments below as the user input for this workflow:

\`\`\`text
$ARGUMENTS
\`\`\`

${body}
`;
}

function stripSkillFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return content.trimStart();
  const end = normalized.indexOf('\n---\n', 4);
  if (end === -1) return content.trimStart();
  return normalized.slice(end + '\n---\n'.length).trimStart();
}

function renderPlatformRule(platform: Platform, language?: 'en' | 'zh'): string {
  const responseLanguage = renderResponseLanguageContract(language);
  const body = `# Kata Agent Contract

Wiki helps agents avoid project-context mistakes; CI, tests, Reviewer, and Judge prevent code-correctness mistakes.

Before non-trivial work:

1. Run \`kata-cli orient --change <id> --role <role> --task-kind <kind>\`.
2. Read returned AGENTS, .llmwiki, model-route, and guard instructions before editing.
3. Use the matching /kata-* skill or its platform command bridge.
4. Capture durable project knowledge into .llmwiki, but never treat Wiki as proof that code is correct.
5. Let tests, CI, reviewer findings, judge results, and phase gates decide correctness.

## Development constraint: skill-first

The /kata-* skill or platform command bridge is the human-facing workflow entrypoint. The kata-cli CLI is the deterministic execution layer used inside skills and scripts.

- Prefer short skill invocations such as /kata-build <intent>, /kata-review, /kata-collect, or 继续.
- A skill must first discover the active/same-branch task with kata-cli status, follow relation redirects, and read nextAction.
- Do not ask the user to provide CLI flags such as --change, --role, or --task-kind unless discovery leaves multiple plausible choices.
- At review_gate and judge_gate, stop, show the recommendation, and wait for the user to switch the host-platform model and resume. Do not claim a switch or write a route before confirmation. At archive_gate, stop for the user's archive decision.
- Use CLI commands directly only for non-interactive automation, tests, CI, or when the host platform cannot execute slash-command skills.
${responseLanguage ? `\n${responseLanguage}` : ''}
`;
  const format = platformDefinitionById[platform].rulesFormat;
  if (format === 'mdc') {
    return `---
description: kata-cli agent contract
globs:
alwaysApply: true
---

${body}`;
  }
  if (format === 'copilot') {
    return `---
applyTo: "**"
---

${body}`;
  }
  return body;
}

function mergeAgentsContract(existing: string, block: string): string {
  if (existing.includes('<!-- STRATA:BEGIN -->') && existing.includes('<!-- STRATA:END -->')) {
    return existing.replace(/<!-- STRATA:BEGIN -->[\s\S]*?<!-- STRATA:END -->\n?/m, block);
  }
  return `${existing.trimEnd()}\n\n${block}`;
}

function removeAgentsContract(content: string): string {
  const begin = '<!-- STRATA:BEGIN -->';
  const end = '<!-- STRATA:END -->';
  const start = content.indexOf(begin);
  const stop = content.indexOf(end);
  if (start === -1 || stop === -1 || stop < start) return content;
  const before = content.slice(0, start).trimEnd();
  const after = content.slice(stop + end.length).trimStart();
  if (before && after) return `${before}\n\n${after}`;
  if (before) return `${before}\n`;
  return after;
}

function renderSkillsIndex(language?: 'en' | 'zh'): string {
  const lines = skillCommands.map((command) => `- \`${command.slashCommand}\` — ${command.summary}`);
  const responseLanguage = renderResponseLanguageContract(language);
  return `# Kata Skills Index

Use these skills for governed project work:

${lines.join('\n')}

${responseLanguage ? `${responseLanguage}\n\n` : ''}Always start with:

\`\`\`bash
kata-cli orient --change <id> --role <role> --task-kind <kind>
\`\`\`

The orientation output links project constraints, LLM Wiki context, allowed writes, phase gates, and the next suggested skill.
`;
}

function renderResponseLanguageContract(language?: 'en' | 'zh'): string {
  if (language === 'zh') {
    return `## Response language

所有面向用户的自然语言响应必须使用中文。代码、命令、文件路径、API 名称、日志和协议字段可以保留原文。`;
  }
  if (language === 'en') {
    return `## Response language

All user-facing natural-language responses must be written in English. Code, commands, file paths, API names, logs, and protocol fields may remain in their original form.`;
  }
  return '';
}

export function skillPath(platform: Platform, commandId: string): string {
  return platformSkillPath(platform, 'project', commandId);
}

export function installationRoot(scope: InstallScope, options: InstallOptions): string {
  if (scope === 'project') return options.root ?? process.cwd();
  return options.home ?? process.env.HOME ?? process.cwd();
}

function manifestBaseRoot(scope: InstallScope, options: InstallOptions): string {
  return scope === 'project' ? (options.root ?? process.cwd()) : (options.home ?? process.env.HOME ?? process.cwd());
}

function createReport(platform: Platform, scope: InstallScope, dryRun: boolean): InstallReport {
  return { platform, scope, planned: [], written: [], removed: [], conflicts: [], unchanged: [], dryRun };
}

function ownedFile(
  platform: Platform,
  scope: InstallScope,
  commandId: string,
  path: string,
  fileHash: string,
): OwnedFile {
  return { platform, scope, commandId, path, sha256: fileHash };
}

async function readManifest(root: string): Promise<OwnershipManifest> {
  const path = manifestPath(root);
  const content = await readOptional(path);
  if (content === undefined) return { version: 1, commandManifest, files: {} };
  const parsed = JSON.parse(content) as unknown;
  if (!isOwnershipManifest(parsed)) throw new Error(`Invalid Kata adapter ownership manifest: ${path}`);
  return parsed;
}

async function writeManifest(root: string, manifest: OwnershipManifest): Promise<void> {
  const path = manifestPath(root);
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function manifestPath(root: string): string {
  return adaptersManifestPath(root);
}

function isOwnershipManifest(value: unknown): value is OwnershipManifest {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { version?: unknown; files?: unknown; commandManifest?: unknown };
  return candidate.version === 1 && typeof candidate.files === 'object' && candidate.files !== null;
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeFileAtomic(path: string, content: string): Promise<void> {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, content, 'utf8');
  await rename(temporaryPath, path);
}

/** @deprecated Use `hashContent` from core/hash.js; kept so existing importers keep working. */
export const sha256 = hashContent;

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
