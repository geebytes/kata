export interface GuardResult {
    passed: boolean;
    phase: string;
    output?: string;
    reason?: string;
}
export interface GuardRunner {
    (action: 'check' | 'apply', change: string, phase: string): Promise<GuardResult>;
}
export declare class CometGuard {
    private readonly run;
    constructor(run: GuardRunner);
    check(change: string, phase: string): Promise<GuardResult>;
    apply(change: string, phase: string): Promise<GuardResult>;
}
//# sourceMappingURL=guard.d.ts.map