export interface CometCompatibility {
    minVersion: string;
    maxVersion?: string;
    capabilities: Record<string, boolean>;
}
export declare function loadCometCompatibility(manifestPath?: string | URL): CometCompatibility;
export declare function assertCometVersion(version: string, compatibility: CometCompatibility): void;
export declare function assertCapability(compatibility: CometCompatibility, capability: string): void;
//# sourceMappingURL=compat.d.ts.map