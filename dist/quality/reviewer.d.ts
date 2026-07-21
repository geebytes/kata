export type ReviewSeverity = 'blocking' | 'major' | 'minor' | 'note';
export interface ReviewFindingInput {
    root?: string;
    taskId: string;
    acceptanceId?: string;
    severity: ReviewSeverity;
    message: string;
    path?: string;
}
export interface ReviewFinding {
    id: string;
    taskId: string;
    acceptanceId?: string;
    severity: ReviewSeverity;
    message: string;
    path?: string;
}
export declare function recordFinding(input: ReviewFindingInput): Promise<ReviewFinding>;
//# sourceMappingURL=reviewer.d.ts.map