import { type AcceptanceCriterion } from '../core/task.js';
import { type Phase } from '../core/state.js';
import { collectEvidence, type CheckCommand } from '../quality/evidence.js';
import { judge } from '../quality/judge.js';
export interface WorkflowFixture {
    root: string;
    taskId: string;
    cleanup: () => Promise<void>;
}
export declare function createOpenFixture(taskId: string, acceptance?: AcceptanceCriterion[]): Promise<WorkflowFixture>;
export declare function advanceTo(root: string, taskId: string, targetPhase: Phase): Promise<void>;
export declare function runImplementFixture(taskId: string, checks?: CheckCommand[]): Promise<WorkflowFixture & {
    evidence: Awaited<ReturnType<typeof collectEvidence>>;
}>;
export declare function runVerifyFixture(taskId: string): Promise<WorkflowFixture & {
    judgeResult: Awaited<ReturnType<typeof judge>>;
}>;
export declare function runRepairFixture(taskId: string): Promise<WorkflowFixture>;
//# sourceMappingURL=fixtures.d.ts.map