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
export declare const platformDefinitions: readonly PlatformDefinition[];
export declare const platformDefinitionById: Record<Platform, PlatformDefinition>;
export declare function platformSkillsDir(platform: Platform, scope: InstallScope): string;
export declare function platformSkillPath(platform: Platform, scope: InstallScope, commandId: string): string;
export declare function platformCommandPath(platform: Platform, scope: InstallScope, commandId: string): string | null;
export declare function platformRulePath(platform: Platform, scope: InstallScope, ruleName: string): string | null;
//# sourceMappingURL=platforms.d.ts.map