import { type InstallOptions, type InstallReport, type InstallScope, type Platform } from './manifest.js';
export declare function install(platform: Platform, scope: InstallScope, options?: InstallOptions): Promise<InstallReport>;
export declare function update(platform: Platform, scope: InstallScope, options?: InstallOptions): Promise<InstallReport>;
export declare function listManagedPlatforms(scope: InstallScope, options?: InstallOptions): Promise<Platform[]>;
export declare function uninstall(platform: Platform, scope: InstallScope, options?: InstallOptions): Promise<InstallReport>;
export declare function skillPath(platform: Platform, commandId: string): string;
export declare function installationRoot(scope: InstallScope, options: InstallOptions): string;
export declare function sha256(content: string): string;
export declare function exists(path: string): Promise<boolean>;
//# sourceMappingURL=ownership.d.ts.map