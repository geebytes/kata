export type CometInstallResult = {
    command: string;
    previousVersion: string | null;
    installedVersion: string;
    method: 'npm' | 'detected';
    path: string;
    compatUpdated: boolean;
};
export type CometVersionResult = {
    version: string | null;
    path: string | null;
    compatible: boolean;
};
export type CometPathResult = {
    path: string | null;
    method: 'npm-global' | 'path' | 'not-found';
};
export type CometVerifyResult = {
    exists: boolean;
    executable: boolean;
    version: string | null;
    compatible: boolean;
    path: string | null;
};
export type CometProjectInitResult = {
    command: 'comet init';
    status: 'initialized' | 'skipped' | 'failed';
    path: string | null;
    root: string;
    scope: 'project' | 'global';
    language?: 'en' | 'zh';
    stdout?: string;
    reason?: string;
};
export declare function resolveCometPath(): Promise<string | null>;
export declare function buildCometInstallInvocation(version?: string): {
    command: string;
    args: string[];
};
export declare function buildCometProjectInitInvocation(input: {
    root: string;
    scope: 'project' | 'global';
    language?: 'en' | 'zh';
    yes?: boolean;
}): {
    command: string;
    args: string[];
};
export declare function initCometProject(input: {
    root: string;
    scope: 'project' | 'global';
    language?: 'en' | 'zh';
    yes?: boolean;
}): Promise<CometProjectInitResult>;
export declare function getCometVersion(binaryPath?: string): Promise<string | null>;
export declare function fetchLatestNpmVersion(): Promise<string | null>;
export declare function installComet(version?: string): Promise<CometInstallResult>;
export declare function updateComet(): Promise<CometInstallResult>;
export declare function verifyComet(): Promise<CometVerifyResult>;
export declare function cometVersion(): CometVersionResult;
export declare function readCometCompatibility(): {
    minVersion: string;
    maxVersion?: string;
};
//# sourceMappingURL=install.d.ts.map