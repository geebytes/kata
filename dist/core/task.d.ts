import { type Phase } from './state.js';
import type { TaskRelation } from './relations.js';
import type { WorkflowProfile } from './workflow-profile.js';
export interface AcceptanceCriterionInput {
    id?: string;
    statement: string;
}
export interface AcceptanceCriterion {
    id?: string;
    statement: string;
}
export type VerificationLevel = 'unit' | 'integration' | 'entrypoint';
export interface MatrixEvidenceItem {
    kind: 'test' | 'lint' | 'typecheck' | 'integration' | 'entrypoint';
    command: string;
    testSelector?: string;
}
export interface AcceptanceMatrixRow {
    acceptanceId: string;
    designRefs?: string[];
    implementationPaths: string[];
    testPaths: string[];
    evidence: MatrixEvidenceItem[];
    verificationLevel: VerificationLevel;
}
export interface AcceptanceMatrix {
    version: 1;
    rows: AcceptanceMatrixRow[];
}
export interface CreateTaskInput {
    root?: string;
    id?: string;
    title: string;
    acceptance: AcceptanceCriterionInput[];
    workflowProfile?: WorkflowProfile;
    ownedPaths?: string[];
    acceptanceMatrix?: AcceptanceMatrix;
}
export interface TaskRecord {
    id: string;
    title: string;
    phase: Phase;
    acceptance: AcceptanceCriterion[];
    relations?: TaskRelation[];
    branch?: string;
    createdAt: string;
    updatedAt: string;
    workflowProfile?: WorkflowProfile;
    ownedPaths?: string[];
    acceptanceMatrix?: AcceptanceMatrix;
}
export declare function createTask(input: CreateTaskInput): Promise<TaskRecord>;
//# sourceMappingURL=task.d.ts.map