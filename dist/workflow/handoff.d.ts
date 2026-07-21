import type { Phase } from '../core/state.js';
export type Role = 'designer' | 'implementer' | 'reviewer' | 'judge' | 'distiller' | 'approver';
export interface HandoffBundle {
    taskId: string;
    fromPhase: Phase;
    toRole: Role;
    context: {
        taskTitle: string;
        acceptance: Array<{
            id?: string;
            statement: string;
        }>;
        evidenceIds: string[];
        wikiRecordIds: string[];
        sourceRefs: string[];
    };
    guardInstructions: string[];
    createdAt: string;
}
export declare function createHandoff(root: string, taskId: string, nextRole: Role): Promise<HandoffBundle>;
//# sourceMappingURL=handoff.d.ts.map