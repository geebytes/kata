export interface TaskRevision {
    id: string;
    taskId: string;
    ownedPaths: string[];
    manifestHash: string;
    createdAt: string;
    ownershipConflicts?: Array<{
        taskId: string;
        path: string;
    }>;
    ownershipConflictsAcknowledged?: boolean;
}
export type RevisionStatus = {
    status: 'current';
} | {
    status: 'superseded';
    expectedManifestHash: string;
    revisionManifestHash: string;
};
export declare function createTaskRevision(input: {
    root: string;
    taskId: string;
    ownedPaths: string[];
    ownershipConflicts?: Array<{
        taskId: string;
        path: string;
    }>;
    ownershipConflictsAcknowledged?: boolean;
}): Promise<TaskRevision>;
export declare function readTaskRevision(root: string, taskId: string, revisionId: string): Promise<TaskRevision>;
export declare function readCurrentTaskRevision(root: string, taskId: string): Promise<TaskRevision | null>;
export declare function revisionStatus(root: string, revision: TaskRevision): Promise<RevisionStatus>;
export declare function computeManifestHash(root: string, ownedPaths: string[]): Promise<string>;
export declare function findOwnershipConflicts(root: string, taskId: string, ownedPaths: string[]): Promise<Array<{
    taskId: string;
    path: string;
}>>;
export declare function workspaceDrift(root: string, ownedPaths: string[]): Promise<string[]>;
export declare function inferOwnedPathsFromWorkspace(root: string): Promise<string[]>;
//# sourceMappingURL=revision.d.ts.map