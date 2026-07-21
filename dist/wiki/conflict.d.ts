import type { WikiRecord } from './record.js';
export interface ConflictEntry {
    type: 'rule' | 'spec' | 'test' | 'code';
    source: string;
    snippet: string;
}
export interface ConflictReport {
    hasConflict: boolean;
    conflicts: ConflictEntry[];
    analysis: string;
}
export declare function checkConflicts(root: string, record: WikiRecord): Promise<ConflictReport>;
//# sourceMappingURL=conflict.d.ts.map