import type { WikiRecord, WikiStatus } from './record.js';
export interface ExcludedWikiEntry {
    id: string;
    status: WikiStatus;
    reason: 'not-authoritative' | 'stale';
}
export interface AuthoritativeContext {
    authoritative: WikiRecord[];
    excluded: ExcludedWikiEntry[];
    warnings: string[];
}
export declare function selectAuthoritativeContext(root: string, requestedSourceRefs: string[]): Promise<AuthoritativeContext>;
//# sourceMappingURL=context.d.ts.map