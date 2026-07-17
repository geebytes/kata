import { join } from 'node:path';
import { resolveWorkspaceRoot } from '../core/layout.js';
import {
  type InstallMode,
  type InstallOptions,
  type InstallReport,
  type InstallScope,
  type Platform,
  type PlatformCapabilities,
  type PlatformComponentState,
  type PlatformInfo,
  type PlatformInstallState,
  type SkillCommand,
  skillCommands as allSkillCommands,
} from './manifest.js';
import { exists, install, listManagedPlatforms, uninstall, update } from './ownership.js';
import { platformDefinitionById, platformDefinitions, platformSkillPath, platformSkillsDir } from './platforms.js';

export { install, listManagedPlatforms, uninstall, update };

export async function discoverPlatforms(options: InstallOptions = {}): Promise<PlatformInfo[]> {
  const root = options.root ?? resolveWorkspaceRoot();
  const home = options.home ?? process.env.HOME ?? resolveWorkspaceRoot();
  const detected: PlatformInfo[] = [];

  for (const platform of platformDefinitions) {
    if (platform.id === 'generic') continue;
    if (await isDetected(platform.id, 'project', root)) detected.push(platformInfo(platform.id, 'project', true, root));
    if (await isDetected(platform.id, 'global', home)) detected.push(platformInfo(platform.id, 'global', true, home));
  }

  detected.push(platformInfo('generic', 'project', true, root));
  return dedupe(detected);
}

async function isDetected(platform: Platform, scope: InstallScope, root: string): Promise<boolean> {
  const definition = platformDefinitionById[platform];
  const paths = definition.detectionPaths ?? [platformSkillsDir(platform, scope)];
  if (platform === 'codex' && scope === 'project') paths.push('AGENTS.md');
  if (platform === 'claude-code' && scope === 'global') paths.push('.claude.json');
  for (const relativePath of paths) {
    if (await exists(join(root, relativePath))) return true;
  }
  return false;
}

function platformInfo(platform: Platform, scope: InstallScope, detected: boolean, root: string): PlatformInfo {
  const capabilities = platformDefinitionById[platform].capabilities;
  return { platform, scope, detected, root, capabilities, unavailable: unavailable(capabilities) };
}

function unavailable(capabilities: PlatformCapabilities): string[] {
  return Object.entries(capabilities)
    .filter(([, supported]) => !supported)
    .map(([capability]) => capability);
}

function dedupe(platforms: PlatformInfo[]): PlatformInfo[] {
  const seen = new Set<string>();
  return platforms.filter((platform) => {
    const key = `${platform.platform}:${platform.scope}:${platform.root}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function identifyPlatformInstallState(
  platform: PlatformInfo,
  options: InstallOptions = {},
): Promise<PlatformInstallState> {
  const root = options.root ?? platform.root;
  const definition = platformDefinitionById[platform.platform];
  const skillPath = platformSkillPath(platform.platform, platform.scope, allSkillCommands[0]?.id ?? '');
  const skillExists = skillPath ? await exists(join(root, skillPath)) : false;
  const rulesDir = definition.rulesDir ?? '';
  const rulesExist = rulesDir ? await exists(join(root, platformSkillsDir(platform.platform, platform.scope), rulesDir)) : false;
  const hooksConfigPath = hookConfigPathFor(platform.platform, platform.scope);
  const hooksExist = hooksConfigPath ? await exists(join(root, hooksConfigPath)) : false;
  const contractExists = await exists(join(root, 'AGENTS.md'));

  return {
    platform,
    components: {
      skills: skillExists ? 'current' : 'absent',
      rules: rulesExist ? 'current' : 'absent',
      hooks: hooksExist ? 'current' : 'absent',
      contract: contractExists ? 'current' : 'absent',
    },
  };
}

function hookConfigPathFor(platform: Platform, scope: InstallScope): string | null {
  const hooks: Record<string, string> = {
    'claude-code': `${platformSkillsDir('claude-code', scope)}/settings.local.json`,
    gemini: `${platformSkillsDir('gemini', scope)}/settings.json`,
    windsurf: `${platformSkillsDir('windsurf', scope)}/hooks.json`,
    copilot: `${platformSkillsDir('github-copilot', scope)}/hooks/kata-guard.json`,
  };
  const definition = platformDefinitionById[platform];
  return definition.hookFormat ? hooks[definition.hookFormat] ?? null : null;
}

export type { InstallOptions, InstallReport, InstallScope, Platform, PlatformInfo, PlatformInstallState };
