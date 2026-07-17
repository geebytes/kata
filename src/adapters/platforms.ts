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

export function platformSkillPath(platform: Platform, scope: InstallScope, commandId: string): string {
  if (platform === 'generic') return `.kata/skills/${commandId}.md`;
  return `${platformSkillsDir(platform, scope)}/skills/${commandId}/SKILL.md`;
}

export function platformCommandPath(platform: Platform, scope: InstallScope, commandId: string): string | null {
  const definition = platformDefinitionById[platform];
  if (!definition.supportsOpenCodeCommands) return null;
  return `${platformSkillsDir(platform, scope)}/commands/${commandId}.md`;
}

export function platformRulePath(platform: Platform, scope: InstallScope, ruleName: string): string | null {
  const definition = platformDefinitionById[platform];
  if (!definition.rulesDir || !definition.rulesFormat) return null;
  const base =
    definition.rulesBaseDir !== undefined
      ? definition.rulesBaseDir === ''
        ? ''
        : definition.rulesBaseDir
      : platformSkillsDir(platform, scope);
  const fileName =
    definition.rulesFormat === 'mdc'
      ? `${ruleName}.mdc`
      : definition.rulesFormat === 'copilot'
        ? `${ruleName}.instructions.md`
        : `${ruleName}.md`;
  return [base, definition.rulesDir, fileName].filter(Boolean).join('/');
}
