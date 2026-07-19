import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { loadConfig, writeConfigPatch } from '../core/config.js';
import { initLlmWiki, buildLlmWikiTask } from '../wiki/llmwiki.js';
import { initCometProject } from '../comet/install.js';
import {
  commandManifest,
  renderSkill,
  skillCommands,
  type InstallOptions,
  type InstallReport,
  type InstallScope,
  type Platform,
} from './manifest.js';
import { platformCommandPath, platformDefinitionById, platformRulePath, platformSkillPath, platformSkillsDir } from './platforms.js';

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
  return writeSkills(platform, scope, options);
}

export async function update(platform: Platform, scope: InstallScope, options: InstallOptions = {}): Promise<InstallReport> {
  return writeSkills(platform, scope, options);
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
  const baseRoot = installationRoot(scope, options);
  const manifestRoot = manifestBaseRoot(scope, options);
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
    const relativePath = platformSkillPath(platform, scope, command.id);
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
    await initCometProject({ root: baseRoot, scope, language: options.language, yes: options.dryRun ? undefined : true });
    try {
      const { execFileSync } = await import('node:child_process');
      const { codeGraphExecutionEnv } = await import('../codegraph/runtime.js');
      execFileSync('codegraph', ['index', '--yes'], { cwd: baseRoot, encoding: 'utf-8', env: codeGraphExecutionEnv() });
    } catch { /* codegraph may not be installed */ }
  }

  if (!effectiveOptions.dryRun) await writeManifest(manifestRoot, manifest);
  return report;
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

  const hookScriptPath = `${platformSkillsDir(platform, scope)}/hooks/kata-hook-guard.mjs`;
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
  const config = hookConfigForPlatform(platform, scope);
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
    const relativePath = platformCommandPath(platform, scope, command.id);
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

  const rulePath = platformRulePath(platform, scope, 'kata-agent-contract');
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

function hookConfigForPlatform(
  platform: Platform,
  scope: InstallScope,
): { relativePath: string; render: (command: string) => string } | null {
  const definition = platformDefinitionById[platform];
  const base = platformSkillsDir(platform, scope);
  switch (definition.hookFormat) {
    case 'claude-code':
      return {
        relativePath: `${base}/settings.local.json`,
        render: (command) => JSON.stringify(claudeCodeHookConfig(command), null, 2) + '\n',
      };
    case 'gemini':
      return {
        relativePath: `${base}/settings.json`,
        render: (command) => JSON.stringify(geminiHookConfig(command), null, 2) + '\n',
      };
    case 'windsurf':
      return {
        relativePath: `${base}/hooks.json`,
        render: (command) => JSON.stringify(windsurfHookConfig(command), null, 2) + '\n',
      };
    case 'copilot':
      return {
        relativePath: `${base}/hooks/kata-guard.json`,
        render: (command) => JSON.stringify(copilotHookConfig(command), null, 2) + '\n',
      };
    default:
      return null;
  }
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
  const taskDir = join(root, '.kata/tasks/wiki-enrich');
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
    relativePath: '.kata/skills-index.md',
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

1. Run \`kata orient --change <id> --role <role> --task-kind <kind>\`.
2. Read AGENTS.md plus the returned \`.llmwiki/SCHEMA.md\`, \`.llmwiki/index.md\`, and \`.llmwiki/log.md\` entries when present.
3. Use the matching \`/kata-*\` skill and follow its startup checklist.
4. Kata 不配置、不路由也不记录宿主平台模型。若需切换，请直接使用宿主平台自己的模型选择器或配置后继续。
5. Do not treat Wiki as proof of code correctness: CI, tests, Reviewer, and Judge own correctness.

## Development constraint: skill-first

For Kata development and dogfooding, the \`/kata-*\` skill is the human-facing workflow entrypoint. The \`kata ...\` CLI is the deterministic execution layer used inside skills and scripts.

- Prefer short skill invocations such as \`/kata-build <intent>\`, \`/kata-review\`, \`/kata-collect\`, or \`继续\`.
- A skill must first discover the active/same-branch task with \`kata status\`, follow relation redirects, and read \`nextAction\`.
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

1. Run \`kata orient --change <id> --role <role> --task-kind <kind>\`.
2. Read returned AGENTS, .llmwiki, model-route, and guard instructions before editing.
3. Use the matching /kata-* skill or its platform command bridge.
4. Capture durable project knowledge into .llmwiki, but never treat Wiki as proof that code is correct.
5. Let tests, CI, reviewer findings, judge results, and phase gates decide correctness.

## Development constraint: skill-first

The /kata-* skill or platform command bridge is the human-facing workflow entrypoint. The kata CLI is the deterministic execution layer used inside skills and scripts.

- Prefer short skill invocations such as /kata-build <intent>, /kata-review, /kata-collect, or 继续.
- A skill must first discover the active/same-branch task with kata status, follow relation redirects, and read nextAction.
- Do not ask the user to provide CLI flags such as --change, --role, or --task-kind unless discovery leaves multiple plausible choices.
- At review_gate and judge_gate, stop, show the recommendation, and wait for the user to switch the host-platform model and resume. Do not claim a switch or write a route before confirmation. At archive_gate, stop for the user's archive decision.
- Use CLI commands directly only for non-interactive automation, tests, CI, or when the host platform cannot execute slash-command skills.
${responseLanguage ? `\n${responseLanguage}` : ''}
`;
  const format = platformDefinitionById[platform].rulesFormat;
  if (format === 'mdc') {
    return `---
description: kata agent contract
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

function renderHookGuardScript(): string {
  return `#!/usr/bin/env node
// Managed by Kata. Active-task hook guard.
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolveArg('--project-root') ?? process.cwd();
const input = await readStdin();
const payload = parseJson(input) ?? {};
const targetPath = extractTargetPath(payload);
const active = readJson(join(root, '.kata/runtime/active-task.json'));

if (!active || !targetPath) process.exit(0);

const taskId = typeof active.taskId === 'string' ? active.taskId : null;
const role = typeof active.role === 'string' ? active.role : 'implementer';
if (!taskId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId)) process.exit(0);

const state = readJson(join(root, '.kata/tasks', taskId, 'current-state.json'));
const task = readJson(join(root, '.kata/tasks', taskId, 'task.json'));
if (!state || !task) process.exit(0);

const phase = typeof state.phase === 'string' ? state.phase : task.phase;
const normalizedPath = normalizeTargetPath(root, targetPath);
const denial = evaluateWrite({ role }, normalizedPath, { ...task, id: taskId, phase });

if (denial) {
  console.error(\`Kata hook blocked write to \${targetPath}: \${denial}\`);
  console.error('Run: kata orient --change ' + taskId + ' --role ' + role);
  process.exit(2);
}

process.exit(0);

function resolveArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    process.stdin.setEncoding('utf8');
    let data = '';
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
  });
}

function parseJson(value) {
  try {
    return value.trim() ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function extractTargetPath(value) {
  const candidates = [
    value?.tool_input?.file_path,
    value?.tool_input?.path,
    value?.file_path,
    value?.path,
    value?.params?.file_path,
    value?.params?.path,
    value?.arguments?.file_path,
    value?.arguments?.path,
  ];
  return candidates.find((candidate) => typeof candidate === 'string') ?? null;
}

function normalizeTargetPath(projectRoot, targetPath) {
  const raw = String(targetPath).replaceAll('\\\\', '/');
  if (!raw || raw.includes('\\u0000')) return null;
  if (/^[A-Za-z]:\\//.test(raw)) return null;
  const absolute = raw.startsWith('/') ? resolve(raw) : resolve(projectRoot, raw);
  const rel = relative(projectRoot, absolute).replaceAll('\\\\', '/');
  if (!rel || rel.startsWith('..') || rel.startsWith('/')) return null;
  if (rel.split('/').includes('..')) return null;
  return rel;
}

function evaluateWrite(actor, normalizedPath, task) {
  if (!normalizedPath) return 'invalid_path';
  if (task.phase === 'intake' || task.phase === 'plan' || task.phase === 'archive') {
    if (normalizedPath.startsWith('src/') || normalizedPath.startsWith('tests/')) return 'phase_scope_violation';
  }
  if (normalizedPath.startsWith('docs/superpowers/rules/') || normalizedPath.startsWith('.kata/wiki/verified/')) {
    return actor.role === 'approver' ? null : 'protected_rules_or_verified_wiki';
  }
  if (actor.role === 'implementer') {
    if (normalizedPath.startsWith('src/') || normalizedPath.startsWith('tests/')) return null;
    if (normalizedPath.startsWith('.kata/tasks/' + task.id + '/')) return null;
    return 'role_scope_violation';
  }
  if (actor.role === 'reviewer') {
    return normalizedPath === '.kata/tasks/' + task.id + '/review.json' ? null : 'role_scope_violation';
  }
  if (actor.role === 'judge') {
    return normalizedPath === '.kata/tasks/' + task.id + '/judge.json' ? null : 'role_scope_violation';
  }
  if (actor.role === 'distiller') {
    return normalizedPath.startsWith('.kata/wiki/candidates/') || normalizedPath === '.kata/tasks/' + task.id + '/wiki-candidate.json'
      ? null
      : 'role_scope_violation';
  }
  if (actor.role === 'approver') return null;
  return 'unknown_role';
}
`;
}

function claudeCodeHookConfig(command: string): Record<string, unknown> {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Write|Edit',
          hooks: [{ type: 'command', command }],
        },
      ],
    },
  };
}

function geminiHookConfig(command: string): Record<string, unknown> {
  return {
    hooks: {
      BeforeTool: [
        {
          matcher: 'write_file|edit_file',
          hooks: [{ type: 'command', command, name: 'Kata phase guard' }],
        },
      ],
    },
  };
}

function windsurfHookConfig(command: string): Record<string, unknown> {
  return {
    hooks: {
      pre_write_code: [{ command, show_output: true }],
    },
  };
}

function copilotHookConfig(command: string): Record<string, unknown> {
  return {
    version: 1,
    hooks: {
      preToolUse: [{ bash: command, powershell: command }],
    },
  };
}

function mergeHookConfig(existing: string, block: string, format: string): string {
  const existingObject = parseJsonObject(existing);
  const blockObject = parseJsonObject(block);
  if (!existingObject) return block;
  if (!blockObject) return existing;

  if (format === 'claude-code') {
    return stringifyJson(mergeGroupedHookConfig(existingObject, blockObject, 'PreToolUse'));
  }
  if (format === 'gemini') {
    return stringifyJson(mergeGroupedHookConfig(existingObject, blockObject, 'BeforeTool'));
  }
  if (format === 'windsurf') {
    return stringifyJson(mergeArrayHookConfig(existingObject, blockObject, 'pre_write_code'));
  }
  if (format === 'copilot') {
    return block;
  }
  return block;
}

function removeManagedHookConfig(content: string, commandId: string): string {
  const format = commandId.replace(/^hook-config:/, '');
  const parsed = parseJsonObject(content);
  if (!parsed) return content;
  if (format === 'claude-code') return stringifyJson(removeGroupedHookConfig(parsed, 'PreToolUse'));
  if (format === 'gemini') return stringifyJson(removeGroupedHookConfig(parsed, 'BeforeTool'));
  if (format === 'windsurf') return stringifyJson(removeArrayHookConfig(parsed, 'pre_write_code'));
  if (format === 'copilot') return '';
  return content;
}

function parseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  return null;
}

function stringifyJson(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function mergeGroupedHookConfig(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  groupName: string,
): Record<string, unknown> {
  const existingHooks = objectRecord(existing.hooks);
  const incomingHooks = objectRecord(incoming.hooks);
  const existingGroups = arrayRecords(existingHooks[groupName]);
  const incomingGroups = arrayRecords(incomingHooks[groupName]);
  const nextGroups = removeManagedGroups(existingGroups);

  for (const incomingGroup of incomingGroups) {
    const matcher = incomingGroup.matcher;
    const existingGroup = nextGroups.find((group) => group.matcher === matcher && Array.isArray(group.hooks));
    if (existingGroup) {
      existingGroup.hooks = [...arrayRecords(existingGroup.hooks), ...arrayRecords(incomingGroup.hooks)];
    } else {
      nextGroups.push(incomingGroup);
    }
  }

  existing.hooks = { ...existingHooks, [groupName]: nextGroups };
  return existing;
}

function removeGroupedHookConfig(existing: Record<string, unknown>, groupName: string): Record<string, unknown> {
  const hooks = objectRecord(existing.hooks);
  const groups = arrayRecords(hooks[groupName]);
  const filtered = removeManagedGroups(groups);
  if (filtered.length > 0) hooks[groupName] = filtered;
  else delete hooks[groupName];
  if (Object.keys(hooks).length > 0) existing.hooks = hooks;
  else delete existing.hooks;
  return existing;
}

function mergeArrayHookConfig(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  arrayName: string,
): Record<string, unknown> {
  const existingHooks = objectRecord(existing.hooks);
  const incomingHooks = objectRecord(incoming.hooks);
  existingHooks[arrayName] = [
    ...arrayRecords(existingHooks[arrayName]).filter((entry) => !isManagedHookEntry(entry)),
    ...arrayRecords(incomingHooks[arrayName]),
  ];
  existing.hooks = existingHooks;
  return existing;
}

function removeArrayHookConfig(existing: Record<string, unknown>, arrayName: string): Record<string, unknown> {
  const hooks = objectRecord(existing.hooks);
  const filtered = arrayRecords(hooks[arrayName]).filter((entry) => !isManagedHookEntry(entry));
  if (filtered.length > 0) hooks[arrayName] = filtered;
  else delete hooks[arrayName];
  if (Object.keys(hooks).length > 0) existing.hooks = hooks;
  else delete existing.hooks;
  return existing;
}

function removeManagedGroups(groups: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return groups.flatMap((group) => {
    const hooks = arrayRecords(group.hooks);
    if (hooks.length === 0) return [group];
    const filteredHooks = hooks.filter((hook) => !isManagedHookEntry(hook));
    if (filteredHooks.length === 0) return [];
    return [{ ...group, hooks: filteredHooks }];
  });
}

function isManagedHookEntry(entry: Record<string, unknown>): boolean {
  return [entry.command, entry.bash, entry.powershell].some(
    (value) => typeof value === 'string' && value.includes('kata-hook-guard.mjs'),
  );
}

function objectRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => objectRecord(entry) === entry) : [];
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
kata orient --change <id> --role <role> --task-kind <kind>
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
  return join(root, '.kata/adapters/manifest.json');
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

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

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
