import { type WikiRecord } from './record.js';
import { type WikiClosure } from './closure.js';
export interface CandidateInput {
    statement: string;
    scope: string[];
    kind: string;
    sourceRefs: string[];
    sourceHashes?: Record<string, string>;
}
export type DistillKnowledgeResult = {
    decision: 'captured';
    candidateIds: string[];
    records: WikiRecord[];
    closure: WikiClosure;
} | {
    decision: 'not_applicable';
    candidateIds: [];
    records: [];
    closure: WikiClosure;
} | {
    decision: 'deferred';
    candidateIds: [];
    records: [];
    reason: string;
};
export declare function proposeFromPassedTask(root: string, taskId: string, input: CandidateInput): Promise<WikiRecord[]>;
export declare function distillPassedTaskKnowledge(root: string, taskId: string): Promise<DistillKnowledgeResult>;
//# sourceMappingURL=provenance.d.ts.map