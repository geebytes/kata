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
import { platformConfigDir, platformDefinitionById, platformDefinitions, platformSkillPath, platformSkillsDir, resolvePlatformGlobalDir } from './platforms.js';

export { install, listManagedPlatforms, uninstall, update };

export async function discoverPlatforms(options: InstallOptions = {}): Promise<PlatformInfo[]> {
  const root = options.root ?? resolveWorkspaceRoot();
  const home = options.home ?? process.env.HOME ?? resolveWorkspaceRoot();
  const detected: PlatformInfo[] = [];

  for (const platform of platformDefinitions) {
    if (platform.id === 'generic') continue;
    if (await isDetected(platform.id, 'project', root)) detected.push(platformInfo(platform.id, 'project', true, root));
    // A platform-specific env var (CODEX_HOME etc.) overrides the default
    // global root. Detection honours it, so the reported root must too —
    // otherwise the wizard displays the env-dir path but installs to $HOME.
    const envDir = resolvePlatformGlobalDir(platform.id);
    const globalRoot = envDir && (await exists(envDir)) ? envDir : home;
    if (await isDetected(platform.id, 'global', home)) detected.push(platformInfo(platform.id, 'global', true, globalRoot));
  }

  detected.push(platformInfo('generic', 'project', true, root));
  return dedupe(detected);
}

async function isDetected(platform: Platform, scope: InstallScope, root: string): Promise<boolean> {
  const definition = platformDefinitionById[platform];

  // Platform-specific environment variables override the default global root
  // so that custom config directories are recognised during detection.
  if (scope === 'global') {
    const envDir = resolvePlatformGlobalDir(platform);
    if (envDir && (await exists(envDir))) return true;
  }

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
  // The platform's own root is authoritative: for global env-var platforms it
  // already points at CODEX_HOME etc., which must not be overridden by the
  // workspace root.
  const root = platform.root ?? options.root ?? options.home;
  const definition = platformDefinitionById[platform.platform];
  const skillPath = platformSkillPath(platform.platform, platform.scope, allSkillCommands[0]?.id ?? '', root);
  const skillExists = skillPath ? await exists(join(root, skillPath)) : false;
  const rulesDir = definition.rulesDir ?? '';
  const rulesExist = rulesDir ? await exists(join(root, platformConfigDir(platform.platform, platform.scope, root), rulesDir)) : false;
  const hooksConfigPath = hookConfigPathFor(platform.platform, platform.scope, root);
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

function hookConfigPathFor(platform: Platform, scope: InstallScope, baseRoot: string): string | null {
  const hooks: Record<string, string> = {
    'claude-code': [platformConfigDir('claude-code', scope, baseRoot), 'settings.local.json'].filter(Boolean).join('/'),
    gemini: [platformConfigDir('gemini', scope, baseRoot), 'settings.json'].filter(Boolean).join('/'),
    windsurf: [platformConfigDir('windsurf', scope, baseRoot), 'hooks.json'].filter(Boolean).join('/'),
    copilot: [platformConfigDir('github-copilot', scope, baseRoot), 'hooks', 'kata-guard.json'].filter(Boolean).join('/'),
  };
  const definition = platformDefinitionById[platform];
  return definition.hookFormat ? hooks[definition.hookFormat] ?? null : null;
}

export type { InstallOptions, InstallReport, InstallScope, Platform, PlatformInfo, PlatformInstallState };
