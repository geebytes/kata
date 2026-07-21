export interface DriftEntry {
    id: string;
    reason: 'source_changed' | 'source_missing';
    changedSources: string[];
}
export interface DriftReport {
    checked: number;
    intact: string[];
    stale: DriftEntry[];
    missing: string[];
}
export declare function verifySources(root: string): Promise<DriftReport>;
export declare function markRecordStale(root: string, id: string): Promise<void>;
//# sourceMappingURL=drift.d.ts.map