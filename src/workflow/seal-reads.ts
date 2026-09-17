import { readValidatedOptional } from '../core/schema.js';
import { repairPath } from '../core/layout.js';
import type { RepairReason, RepairRecordShape } from '../quality/repair.js';
import type { RepairScope } from '../quality/judge.js';

/**
 * The seal path's reads.
 *
 * `readActiveReviewRepairBaseline` and `readActiveRepair` used to live in the orchestrator, which meant the seal's
 * preflight could not ask them without importing the module that calls it. They are reads with no side effects, so they
 * belong here, beside the repair record they interpret.
 */

export async function readActiveReviewRepairBaseline(root: string, taskId: string): Promise<string | undefined> {
    const repair = await readValidatedOptional<RepairRecordShape>('repair', repairPath(root, taskId));
    if (!repair) return undefined;
    // 两种评审修复原因都要参与「必须先改变 manifest 才能 seal」的校验：
    // review_findings（按严重级授权）与 revision_superseded（按证据漂移授权）。
    const isReviewRepair = repair.reason === 'review_findings' || repair.reason === 'revision_superseded';
    if (!isReviewRepair || repair.resolvedAt || !repair.baselineManifestHash) return undefined;
    return repair.baselineManifestHash;
}

export interface ActiveRepair {
    reason?: RepairReason;
    scopes: Array<{ id?: string; repairScope?: RepairScope }>;
}

/**
 * The repair a task is currently working through, if any. Repairs that are done (`resolvedAt`) do not
 * constrain the next seal: a sealed revision resolves the repair that produced it.
 */
export async function readActiveRepair(root: string, taskId: string): Promise<ActiveRepair | null> {
    const repair = await readValidatedOptional<RepairRecordShape>('repair', repairPath(root, taskId));
    if (!repair || repair.resolvedAt) return null;
    return {
        ...(repair.reason ? { reason: repair.reason } : {}),
        scopes: Array.isArray(repair.scopes)
            ? repair.scopes.map((scope) => ({ id: scope.id, repairScope: scope.repairScope as RepairScope | undefined }))
            : [],
    };
}
