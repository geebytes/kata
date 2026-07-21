import { type InstallOptions, type InstallScope, type Platform } from './manifest.js';
export type DoctorStatus = 'ok' | 'missing' | 'conflict' | 'skipped';
export type DoctorCheck = {
    path: string;
    kind: 'skill' | 'rule' | 'hook' | 'command' | 'support' | 'wiki';
    status: DoctorStatus;
    reason?: string;
};
export type DoctorReport = {
    command: 'doctor';
    platform: Platform;
    scope: InstallScope;
    root: string;
    ok: boolean;
    checks: DoctorCheck[];
    summary: {
        ok: number;
        missing: number;
        conflicts: number;
        skipped: number;
    };
};
export declare function doctor(platform: Platform, scope: InstallScope, options?: InstallOptions): Promise<DoctorReport>;
//# sourceMappingURL=doctor.d.ts.map