import { type Role } from './handoff.js';
import type { WorkflowProfile } from '../core/workflow-profile.js';
type HandoffAnchorScope = {
    kind: 'revision';
    revisionId: string;
    paths: string[];
    hash: string;
} | {
    kind: 'task_context';
    paths: string[];
    hash: string;
};
export interface HandoffPacket {
    protocolVersion: 1;
    id: string;
    taskId: string;
    createdAt: string;
    from: {
        role: Role;
        platform?: string;
    };
    to: {
        role: Role;
        preferredPlatforms?: string[];
    };
    phase: string;
    repository: {
        head: string | null;
        branch: string | null;
        diffHash: string;
        scope?: HandoffAnchorScope;
        worktreeRoot: '.';
    };
    task: {
        title: string;
        acceptance: Array<{
            id: string;
            statement: string;
        }>;
        workflowProfile?: WorkflowProfile;
    };
    context: {
        requiredReads: string[];
        designRefs: string[];
        sourceRefs: string[];
        authoritativeWiki: Array<{
            id: string;
            path: string;
        }>;
        excludedWiki: Array<{
            id: string;
            reason: string;
        }>;
        evidencePaths: string[];
        priorArtifacts: string[];
    };
    permissions: {
        allowedWrites: string[];
        guardInstructions: string[];
    };
    nextAction: string;
}
export interface HandoffReceipt {
    protocolVersion: 1;
    taskId: string;
    handoffId: string;
    platform: string;
    role: Role;
    packetSha256: string;
    acknowledgedAt: string;
    repository: HandoffPacket['repository'];
}
export type ContextPacketVerification = {
    valid: true;
} | {
    valid: false;
    reason: 'head_mismatch' | 'branch_mismatch' | 'diff_mismatch' | 'packet_hash_mismatch';
};
export declare function createContextPacket(input: {
    root: string;
    taskId: string;
    fromRole: Role;
    toRole: Role;
    platform?: string;
}): Promise<HandoffPacket>;
export declare function readContextPacket(root: string, taskId: string, id: string): Promise<HandoffPacket>;
export declare function acknowledgeContextPacket(input: {
    root: string;
    taskId: string;
    id: string;
    platform: string;
    role: Role;
}): Promise<HandoffReceipt>;
export declare function verifyContextPacket(input: {
    root: string;
    taskId: string;
    id: string;
}): Promise<ContextPacketVerification>;
export {};
//# sourceMappingURL=context-fabric.d.ts.map