import { type ResolvedModelRoute, type Tier } from './model-policy.js';
export type ModelSelectionMode = 'recommended' | 'current' | 'custom';
export interface ModelRouteRecommendation {
    provider: string;
    model: string;
    platformOptions: Record<string, Record<string, string>>;
    costRatio?: number;
}
export interface ModelRouteDecision {
    mode: ModelSelectionMode;
    platform: string;
    decidedBy: 'host' | 'policy';
    reason: string;
    model?: string;
    /** Strata cannot switch a host session model; this is an external attestation. */
    hostModelConfirmed: boolean;
    selectedPlatformOptions: Record<string, string>;
}
export interface ModelRouteArtifact extends ResolvedModelRoute {
    taskId: string;
    platform: string;
    recommendation: ModelRouteRecommendation;
    decision: ModelRouteDecision;
    selectedPlatformOptions: Record<string, string>;
    recordedAt: string;
}
export interface RecordModelRouteInput {
    root: string;
    taskId: string;
    role: string;
    platform?: string;
    taskKind?: string;
    routingMode?: string;
    failureCount?: number;
    selection?: ModelSelectionMode;
    model?: string;
    hostModelConfirmed?: boolean;
}
export declare function recordModelRoute(input: RecordModelRouteInput): Promise<ModelRouteArtifact>;
export declare function resolveDecision(input: {
    selection: ModelSelectionMode;
    platform: string;
    model?: string;
    routeModel: string;
    platformOptions: Record<string, string>;
}): ModelRouteDecision;
export declare function assertPhaseModelRoute(root: string, taskId: string, role: string, minimumTier: Tier): Promise<void>;
export declare function relativeModelRouteArtifactPath(taskId: string, role: string): string;
export declare function assertValidRoleId(role: string): void;
