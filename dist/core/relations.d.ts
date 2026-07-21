export type TaskRelationType = 'superseded_by' | 'covered_by' | 'duplicate_of' | 'merged_into' | 'parent_of' | 'spawned_from' | 'related_to' | 'contains' | 'implements' | 'repairs' | 'depends_on' | 'blocked_by';
export type RelationEndpointType = 'task' | 'change';
export type RelationEndpoint = {
    type: RelationEndpointType;
    id: string;
};
export type RelationKind = 'ownership' | 'lineage' | 'control' | 'context';
export type KataRelation = {
    kind: RelationKind;
    type: TaskRelationType;
    from: RelationEndpoint;
    to: RelationEndpoint;
    reason?: string;
    createdAt: string;
    createdBy?: string;
};
export type KataRelationsGraph = {
    version: 1;
    relations: KataRelation[];
    updatedAt: string;
};
export type TaskRelation = {
    type: TaskRelationType;
    targetTaskId: string;
    reason?: string;
    createdAt: string;
    createdBy?: string;
};
export type TaskRelationsRecord = {
    taskId: string;
    relations: TaskRelation[];
    updatedAt: string;
};
export declare const terminalRelationTypes: readonly TaskRelationType[];
export declare const relationTypes: readonly TaskRelationType[];
export declare function isTerminalRelation(type: string): type is TaskRelationType;
export declare function addTaskRelation(input: {
    root: string;
    fromTaskId: string;
    toTaskId: string;
    type: TaskRelationType;
    reason?: string;
    createdBy?: string;
}): Promise<TaskRelationsRecord>;
export declare function addKataRelation(input: {
    root: string;
    from: RelationEndpoint;
    to: RelationEndpoint;
    type: TaskRelationType;
    kind?: RelationKind;
    reason?: string;
    createdAt?: string;
    createdBy?: string;
}): Promise<KataRelationsGraph>;
export declare function readKataRelations(root: string): Promise<KataRelationsGraph>;
export declare function findKataRelations(root: string, endpoint: RelationEndpoint): Promise<{
    endpoint: RelationEndpoint;
    outgoing: KataRelation[];
    incoming: KataRelation[];
}>;
export declare function readTaskRelations(root: string, taskId: string): Promise<TaskRelationsRecord>;
export declare function readTerminalTaskRelation(root: string, taskId: string): Promise<TaskRelation | null>;
export declare function resolveTerminalTask(root: string, taskId: string): Promise<{
    taskId: string;
    redirects: Array<{
        fromTaskId: string;
        toTaskId: string;
        type: TaskRelationType;
        reason?: string;
    }>;
}>;
//# sourceMappingURL=relations.d.ts.map