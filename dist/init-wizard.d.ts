import type { Readable } from 'node:stream';
import type { Writable } from 'node:stream';
import type { InstallOptions, InstallReport, InstallScope, PlatformInfo } from './adapters/manifest.js';
export interface InitPlan {
    scope: InstallScope;
    selected: PlatformInfo[];
    detected: PlatformInfo[];
    language: 'en' | 'zh';
}
export interface InitWizardIo {
    input?: Readable;
    output?: Writable;
}
export declare function renderInitBanner(): string;
export declare function planDetectedInit(platforms: PlatformInfo[], settings?: {
    scope?: InstallScope;
    language?: 'en' | 'zh';
}): InitPlan;
export declare function mergeInstallReports(input: {
    command: 'init' | 'update';
    mode: 'auto' | 'interactive';
    scope: InstallScope;
    reports: InstallReport[];
}): Record<string, unknown>;
export declare function promptInitPlan(platforms: PlatformInfo[], io?: InitWizardIo): Promise<InitPlan>;
export declare function optionsForWizardInstall(base: InstallOptions, scope: InstallScope, platformRoot: string, language?: 'en' | 'zh'): InstallOptions;
//# sourceMappingURL=init-wizard.d.ts.map