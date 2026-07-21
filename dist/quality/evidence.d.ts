import type { TaskRevision } from '../workflow/revision.js';
export type CheckProgressState = 'started' | 'passed' | 'failed' | 'timed_out' | 'cancelled';
export interface CheckProgressEvent {
    type: 'quality_check_progress';
    check: string;
    state: CheckProgressState;
    timeoutMs: number;
    exitCode?: number | null;
}
export type EvidenceKind = 'lint' | 'typecheck' | 'test' | 'ci' | 'review' | 'judge' | 'security' | 'integration' | 'entrypoint';
export interface ImportedCheckResult {
    exitCode: number;
    log?: string;
    environment?: string;
}
export interface CheckCommand {
    name?: string;
    kind: EvidenceKind;
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    redact?: string[];
    importResult?: ImportedCheckResult;
}
export interface EvidenceCollectionOptions {
    scopePaths?: string[];
    revision?: TaskRevision;
    signal?: AbortSignal;
    onProgress?: (event: CheckProgressEvent) => void;
}
export interface EvidenceEnvelope {
    id: string;
    taskId: string;
    name?: string;
    kind: EvidenceKind;
    command: string;
    environment?: string;
    exitCode: number;
    startedAt: string;
    finishedAt: string;
    diffHash: string;
    revisionId?: string;
    scope?: EvidenceScope;
    log?: string;
}
export interface EvidenceScope {
    paths: string[];
    hash: string;
}
export type FreshnessResult = {
    fresh: true;
} | {
    fresh: false;
    reason: 'diff_hash_mismatch';
    expectedDiffHash: string;
    evidenceDiffHash: string;
} | {
    fresh: false;
    reason: 'scope_hash_mismatch';
    expectedScopeHash: string;
    evidenceScopeHash: string;
};
export declare function collectEvidence(taskId: string, commands: CheckCommand[], options?: EvidenceCollectionOptions): Promise<EvidenceEnvelope[]>;
export declare function checkFreshness(evidence: EvidenceEnvelope, diffHash: string, scopeHash?: string): FreshnessResult;
export declare function computeScopeHash(root: string, paths: string[]): Promise<string>;
export declare function computeDiffHash(root?: string): Promise<string>;
//# sourceMappingURL=evidence.d.ts.map