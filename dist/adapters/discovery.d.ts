import { type InstallOptions, type InstallReport, type InstallScope, type Platform, type PlatformInfo, type PlatformInstallState } from './manifest.js';
import { install, listManagedPlatforms, uninstall, update } from './ownership.js';
export { install, listManagedPlatforms, uninstall, update };
export declare function discoverPlatforms(options?: InstallOptions): Promise<PlatformInfo[]>;
export declare function identifyPlatformInstallState(platform: PlatformInfo, options?: InstallOptions): Promise<PlatformInstallState>;
export type { InstallOptions, InstallReport, InstallScope, Platform, PlatformInfo, PlatformInstallState };
//# sourceMappingURL=discovery.d.ts.map