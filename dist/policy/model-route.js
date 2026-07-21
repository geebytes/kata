import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../core/config.js';
import { assertValidTaskId } from '../core/ids.js';
import { resolveModelRoute } from './model-policy.js';
export async function recordModelRoute(input) {
    assertValidTaskId(input.taskId);
    assertValidRoleId(input.role);
    const platform = input.platform ?? 'generic';
    const config = await loadConfig(input.root);
    const route = resolveModelRoute(input.role, config.modelPolicy, {
        ...(input.taskKind ? { taskKind: input.taskKind } : {}),
        ...(input.routingMode ? { routingMode: input.routingMode } : {}),
        ...(input.failureCount !== undefined ? { failureCount: input.failureCount } : {}),
    });
    const selection = input.selection ?? config.modelPolicy.defaultSelection ?? 'recommended';
    if (!input.hostModelConfirmed) {
        throw new Error('Refusing to record a model route without host confirmation; switch the model in the host platform, then rerun with --confirm-host-model.');
    }
    const platformOptions = route.platformOptions[platform] ?? {};
    const decision = resolveDecision({
        selection,
        platform,
        model: input.model,
        routeModel: route.model,
        platformOptions,
    });
    const artifact = {
        ...route,
        taskId: input.taskId,
        platform,
        recommendation: {
            provider: route.provider,
            model: route.model,
            platformOptions: route.platformOptions,
            ...(route.costRatio !== undefined ? { costRatio: route.costRatio } : {}),
        },
        decision,
        selectedPlatformOptions: decision.selectedPlatformOptions,
        recordedAt: new Date().toISOString(),
    };
    const directory = join(input.root, '.strata/tasks', input.taskId, 'model-routes');
    await mkdir(directory, { recursive: true });
    await writeFile(modelRouteArtifactPath(input.root, input.taskId, input.role), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    return artifact;
}
export function resolveDecision(input) {
    if (input.selection === 'custom') {
        if (!input.model)
            throw new Error('Usage: --select custom requires --model <model>');
        return {
            mode: 'custom',
            platform: input.platform,
            decidedBy: 'host',
            reason: 'The host platform model was externally confirmed for this task and role; Strata did not perform the switch.',
            model: input.model,
            hostModelConfirmed: true,
            selectedPlatformOptions: { ...input.platformOptions, model: input.model },
        };
    }
    if (input.selection === 'current') {
        if (!input.model)
            throw new Error('Usage: --select current requires --model <actual-host-model>');
        return {
            mode: 'current',
            platform: input.platform,
            decidedBy: 'host',
            reason: 'The active host session model was externally confirmed; Strata did not perform the selection.',
            model: input.model,
            hostModelConfirmed: true,
            selectedPlatformOptions: { ...input.platformOptions, model: input.model },
        };
    }
    const selectedModel = input.platformOptions.model ?? input.routeModel;
    return {
        mode: 'recommended',
        platform: input.platform,
        decidedBy: 'policy',
        reason: 'The host platform was externally confirmed after applying the Strata model policy recommendation.',
        model: selectedModel,
        hostModelConfirmed: true,
        selectedPlatformOptions: input.platformOptions,
    };
}
export async function assertPhaseModelRoute(root, taskId, role, minimumTier) {
    assertValidTaskId(taskId);
    assertValidRoleId(role);
    const config = await loadConfig(root);
    if (!config.modelPolicy.routing)
        return;
    let artifact;
    try {
        artifact = JSON.parse(await readFile(modelRouteArtifactPath(root, taskId, role), 'utf8'));
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
            throw new Error(`Missing model route artifact for ${role}; run strata models route --role ${role} --task ${taskId} --write`);
        }
        throw error;
    }
    if (artifact.role !== role || artifact.taskId !== taskId) {
        throw new Error(`Invalid model route artifact for ${role}: task or role mismatch`);
    }
    if (!artifact.decision.hostModelConfirmed) {
        throw new Error(`Invalid model route artifact for ${role}: host model was not confirmed`);
    }
    if (!tierAtLeast(artifact.tier, minimumTier)) {
        throw new Error(`Invalid model route artifact for ${role}: tier ${artifact.tier} is below required ${minimumTier}`);
    }
    const configuredRoute = config.modelPolicy.routing?.[artifact.tier];
    if (!configuredRoute || artifact.provider !== configuredRoute.provider || artifact.model !== configuredRoute.model) {
        throw new Error(`Invalid model route artifact for ${role}: does not match current model policy`);
    }
}
export function relativeModelRouteArtifactPath(taskId, role) {
    assertValidTaskId(taskId);
    assertValidRoleId(role);
    return `.strata/tasks/${taskId}/model-routes/${role}.json`;
}
export function assertValidRoleId(role) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(role)) {
        throw new Error(`Invalid model route role: ${role}`);
    }
}
function modelRouteArtifactPath(root, taskId, role) {
    return join(root, relativeModelRouteArtifactPath(taskId, role));
}
function tierAtLeast(actual, minimum) {
    return tierRank(actual) >= tierRank(minimum);
}
function tierRank(tier) {
    if (tier === 'economy')
        return 0;
    if (tier === 'capable')
        return 1;
    return 2;
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
