export declare const orderedPhases: readonly ["intake", "plan", "implement", "hardVerify", "review", "judge", "distill", "archive"];
export type Phase = (typeof orderedPhases)[number];
export interface Actor {
    id: string;
    role: string;
    platform?: string;
}
export interface TransitionOptions {
    root?: string;
    activeSession?: string;
}
export interface StateRecord {
    taskId: string;
    phase: Phase;
    actor: Actor;
    updatedAt: string;
    activeSession?: string;
}
export interface StateEvent {
    taskId: string;
    from: Phase | null;
    to: Phase;
    actor: Actor;
    at: string;
    activeSession?: string;
}
export declare function isLegalPhaseTransition(from: Phase, to: Phase): boolean;
export declare function transition(taskId: string, to: Phase, actor: Actor, options?: TransitionOptions): Promise<StateRecord>;
export declare function appendStateEvent(root: string, event: StateEvent): Promise<void>;
export declare function writeCurrentState(root: string, state: StateRecord): Promise<void>;
export declare function readStateEvents(root: string, taskId: string): Promise<StateEvent[]>;
//# sourceMappingURL=state.d.ts.map