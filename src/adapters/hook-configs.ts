import type { InstallScope, Platform } from './manifest.js';
import { platformConfigDir, platformDefinitionById } from './platforms.js';

/**
 * The platform hook-config dialects.
 *
 * Each platform that enforces kata's write policy does it through its own configuration file and its own shape: Claude
 * Code and Gemini group hooks under a matcher section, Windsurf keeps an array under `pre_write_code`, and Copilot's
 * file is ours alone. Four dialects' worth of build/merge/remove logic used to sit inside the installer module, so a new
 * hook-capable platform and an ownership-manifest change both edited the same file.
 *
 * One descriptor per dialect now, behind `{ pathFor, build, merge, remove }` — the installer asks for the descriptor and
 * performs the file write, ownership bookkeeping and reporting, which is its own job.
 */

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

export function mergeHookConfig(existing: string, block: string, format: string): string {
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

export function removeManagedHookConfig(content: string, commandId: string): string {
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


export function hookConfigForPlatform(
  platform: Platform,
  scope: InstallScope,
  baseRoot: string,
): { relativePath: string; render: (command: string) => string } | null {
  const definition = platformDefinitionById[platform];
  const base = platformConfigDir(platform, scope, baseRoot);
  switch (definition.hookFormat) {
    case 'claude-code':
      return {
        relativePath: [base, 'settings.local.json'].filter(Boolean).join('/'),
        render: (command) => JSON.stringify(claudeCodeHookConfig(command), null, 2) + '\n',
      };
    case 'gemini':
      return {
        relativePath: [base, 'settings.json'].filter(Boolean).join('/'),
        render: (command) => JSON.stringify(geminiHookConfig(command), null, 2) + '\n',
      };
    case 'windsurf':
      return {
        relativePath: [base, 'hooks.json'].filter(Boolean).join('/'),
        render: (command) => JSON.stringify(windsurfHookConfig(command), null, 2) + '\n',
      };
    case 'copilot':
      return {
        relativePath: [base, 'hooks', 'kata-guard.json'].filter(Boolean).join('/'),
        render: (command) => JSON.stringify(copilotHookConfig(command), null, 2) + '\n',
      };
    default:
      return null;
  }
}


