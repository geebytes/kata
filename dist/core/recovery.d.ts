export interface RecoveryOptions {
    root?: string;
}
export interface RecoveryDiagnostic {
    taskId: string;
    phase: string;
    recoveredActiveSession?: string;
    actions: string[];
}
export declare function recover(taskId: string, options?: RecoveryOptions): Promise<RecoveryDiagnostic>;
//# sourceMappingURL=recovery.d.ts.map