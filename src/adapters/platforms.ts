import type { InstallScope, Platform, PlatformCapabilities } from './manifest.js';

export type RuleFormat = 'md' | 'mdc' | 'copilot';
export type HookFormat = 'claude-code' | 'gemini' | 'windsurf' | 'copilot';

export type PlatformDefinition = {
  id: Platform;
  name: string;
  skillsDir: string;
  globalSkillsDir?: string;
  detectionPaths?: string[];
  rulesDir?: string;
  rulesBaseDir?: string;
  rulesFormat?: RuleFormat;
  supportsOpenCodeCommands?: boolean;
  hookFormat?: HookFormat;
  capabilities: PlatformCapabilities;
  modelSelectionInstruction?: string;
};

const defaultSkillsCapabilities: PlatformCapabilities = {
  skills: true,
  hooks: false,
  subAgents: false,
  modelSelection: true,
};

const hookCapabilities: PlatformCapabilities = {
  skills: true,
  hooks: true,
  subAgents: true,
  modelSelection: true,
};

export const platformDefinitions: readonly PlatformDefinition[] = [
  {
    id: 'codex',
    name: 'Codex',
    skillsDir: '.codex',
    globalSkillsDir: '.codex',
    rulesDir: 'rules',
    rulesFormat: 'md',
    hookFormat: 'claude-code',
    capabilities: { skills: true, hooks: true, subAgents: true, modelSelection: true },
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    skillsDir: '.claude',
    globalSkillsDir: '.claude',
    rulesDir: 'rules',
    rulesFormat: 'md',
    hookFormat: 'claude-code',
    capabilities: hookCapabilities,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    skillsDir: '.opencode',
    globalSkillsDir: '.config/opencode',
    detectionPaths: ['opencode.json', '.opencode'],
    rulesDir: 'rules',
    rulesFormat: 'md',
    supportsOpenCodeCommands: true,
    modelSelectionInstruction: 'OpenCode：如需切换模型，先执行 `/models` 并在其交互界面完成选择，再运行本次委托的 Kata 命令。',
    capabilities: { skills: true, hooks: false, subAgents: true, modelSelection: true },
  },
  {
    id: 'cursor',
    name: 'Cursor',
    skillsDir: '.cursor',
    globalSkillsDir: '.cursor',
    rulesDir: 'rules',
    rulesFormat: 'mdc',
    capabilities: defaultSkillsCapabilities,
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    skillsDir: '.windsurf',
    globalSkillsDir: '.windsurf',
    rulesDir: 'rules',
    rulesFormat: 'md',
    hookFormat: 'windsurf',
    capabilities: hookCapabilities,
  },
  {
    id: 'cline',
    name: 'Cline',
    skillsDir: '.cline',
    globalSkillsDir: '.cline',
    detectionPaths: ['.cline', '.clinerules'],
    rulesBaseDir: '',
    rulesDir: '.clinerules',
    rulesFormat: 'md',
    capabilities: defaultSkillsCapabilities,
  },
  {
    id: 'roocode',
    name: 'RooCode',
    skillsDir: '.roo',
    globalSkillsDir: '.roo',
    rulesDir: 'rules',
    rulesFormat: 'md',
    capabilities: defaultSkillsCapabilities,
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    skillsDir: '.gemini',
    globalSkillsDir: '.gemini',
    hookFormat: 'gemini',
    capabilities: hookCapabilities,
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    skillsDir: '.github',
    globalSkillsDir: '.github',
    detectionPaths: ['.github/copilot-instructions.md', '.github/instructions', '.github/prompts', '.github/skills'],
    rulesDir: 'instructions',
    rulesFormat: 'copilot',
    hookFormat: 'copilot',
    capabilities: hookCapabilities,
  },
  {
    id: 'generic',
    name: 'Generic',
    skillsDir: '.kata',
    rulesDir: 'rules',
    rulesFormat: 'md',
    capabilities: { skills: true, hooks: false, subAgents: false, modelSelection: false },
  },
] as const;

export const platformDefinitionById: Record<Platform, PlatformDefinition> = Object.fromEntries(
  platformDefinitions.map((platform) => [platform.id, platform]),
) as Record<Platform, PlatformDefinition>;

export function platformSkillsDir(platform: Platform, scope: InstallScope): string {
  const definition = platformDefinitionById[platform];
  return scope === 'global' && definition.globalSkillsDir ? definition.globalSkillsDir : definition.skillsDir;
}

/**
 * Resolve the config-directory override for a platform, if one is configured
 * via its platform-specific environment variable. Kata treats these env vars
 * (CODEX_HOME / CLAUDE_CONFIG_DIR / OPENCODE_CONFIG_DIR) as the authoritative
 * install root for the global scope: when set, the skills live directly under
 * that directory rather than under `$HOME/<platformSkillsDir>`.
 */
export function resolvePlatformGlobalDir(platform: Platform): string | null {
  if (platform === 'codex' && process.env.CODEX_HOME) return process.env.CODEX_HOME;
  if (platform === 'claude-code' && process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  if (platform === 'opencode' && process.env.OPENCODE_CONFIG_DIR) return process.env.OPENCODE_CONFIG_DIR;
  return null;
}

/**
 * The relative (to `baseRoot`) directory that holds this platform's config.
 * When the global install root IS the platform's env-dir, the platform config
 * lives at the root itself — otherwise it is `<platformSkillsDir>` (e.g.
 * `.codex`, `.config/opencode`). This keeps kata's install target identical
 * to the path the wizard displays for env-var-configured platforms.
 */
export function platformConfigDir(platform: Platform, scope: InstallScope, baseRoot?: string): string {
  if (scope === 'global' && baseRoot) {
    const envDir = resolvePlatformGlobalDir(platform);
    if (envDir && baseRoot === envDir) return '';
  }
  return platformSkillsDir(platform, scope);
}

export function platformSkillPath(platform: Platform, scope: InstallScope, commandId: string, baseRoot?: string): string {
  if (platform === 'generic') return `.kata/skills/${commandId}.md`;
  const base = platformConfigDir(platform, scope, baseRoot);
  return [base, 'skills', commandId, 'SKILL.md'].filter(Boolean).join('/');
}

export function platformCommandPath(platform: Platform, scope: InstallScope, commandId: string, baseRoot?: string): string | null {
  const definition = platformDefinitionById[platform];
  if (!definition.supportsOpenCodeCommands) return null;
  const base = platformConfigDir(platform, scope, baseRoot);
  return [base, 'commands', `${commandId}.md`].filter(Boolean).join('/');
}

export function platformRulePath(platform: Platform, scope: InstallScope, ruleName: string, baseRoot?: string): string | null {
  const definition = platformDefinitionById[platform];
  if (!definition.rulesDir || !definition.rulesFormat) return null;
  const base =
    definition.rulesBaseDir !== undefined
      ? definition.rulesBaseDir === ''
        ? ''
        : definition.rulesBaseDir
      : platformConfigDir(platform, scope, baseRoot);
  const fileName =
    definition.rulesFormat === 'mdc'
      ? `${ruleName}.mdc`
      : definition.rulesFormat === 'copilot'
        ? `${ruleName}.instructions.md`
        : `${ruleName}.md`;
  return [base, definition.rulesDir, fileName].filter(Boolean).join('/');
}
