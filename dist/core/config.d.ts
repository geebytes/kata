import type { EvidenceKind } from '../quality/evidence.js';
export type ResponseLanguage = 'en' | 'zh';
export type KataConfig = {
    language?: ResponseLanguage;
    quality?: {
        buildChecks?: Array<{
            name?: string;
            kind?: EvidenceKind;
            command: string;
            args?: string[];
            timeoutMs?: number;
        }>;
    };
};
export declare function loadConfig(root: string): Promise<KataConfig>;
export declare function readConfigObject(root: string): Promise<Record<string, unknown>>;
export declare function writeConfigPatch(root: string, patch: Record<string, unknown>): Promise<Record<string, unknown>>;
//# sourceMappingURL=config.d.ts.map