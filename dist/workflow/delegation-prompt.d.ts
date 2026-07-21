import { type HandoffPacket } from './context-fabric.js';
export declare function createWorkflowHandoff(input: {
    root: string;
    taskId: string;
    fromRole: 'designer' | 'implementer' | 'reviewer' | 'judge' | 'distiller';
    toRole: 'designer' | 'implementer' | 'reviewer' | 'judge' | 'distiller';
}): Promise<{
    packet: HandoffPacket;
    prompt: string;
}>;
export declare function renderDelegationPrompt(taskId: string, handoffId: string, platform: string, role: string, designRefs?: string[]): string;
//# sourceMappingURL=delegation-prompt.d.ts.map